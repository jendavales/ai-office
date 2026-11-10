'use strict';
/**
 * Claude Code sessions run by AI Office itself – the way Claude desktop runs them: one
 * `claude -p --input-format stream-json --output-format stream-json` process per session, your messages
 * go in over stdin, Claude's replies stream back as JSON lines. It is the official CLI with its own login,
 * so it runs on your subscription, and your hooks keep the office in sync like with any other session.
 *
 * Events: 'item' { id, index, item, seq } · 'state' summary · 'status' (status-line shaped: cost, rate limits)
 */
const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { basename, oneLine } = require('./hook-events');
const { projectRoot } = require('./project');
const { addNotice, addUser, apply, createConversation, fromTranscript, rateLimits, settle } = require('./stream-events');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_MARK = '__AI_OFFICE_ENV__';
const FALLBACK_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const STOP_GRACE_MS = 4000;

/** Arguments of one session process. The permission mode is left to your Claude Code settings. */
function buildArgs({ id, resume }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    resume ? '--resume' : '--session-id', id,
  ];
}

/** Without the variables of a Claude session that AI Office itself may have been started from. */
const cleanEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/.test(k)));

/** Output of `$SHELL -ilc "printf MARK; env -0"` → environment (rc files may print noise before the mark). */
function parseEnvProbe(out) {
  const at = String(out).lastIndexOf(ENV_MARK);
  if (at < 0) return null;
  const env = {};
  for (const entry of String(out).slice(at + ENV_MARK.length).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  for (const k of ['PWD', 'OLDPWD', '_', 'SHLVL']) delete env[k];
  return env.PATH ? env : null;
}

/** First executable `name` on a PATH. */
function findOnPath(name, PATH) {
  for (const dir of String(PATH ?? '').split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

/** Claude's folder name for a working directory under ~/.claude/projects. */
const projectDirName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** Transcript of a session: the folder of its working directory first, then any project (sessions can move). */
function findTranscript(projectsDir, id, cwd) {
  if (!UUID.test(id)) return null;
  const direct = cwd && path.join(projectsDir, projectDirName(cwd), `${id}.jsonl`);
  if (direct && fs.existsSync(direct)) return direct;
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * The environment a fresh terminal would have (an app started from Finder only gets a minimal PATH,
 * so neither `claude` nor the tools it runs – git, node, … – would be found).
 */
function loginEnv() {
  const base = cleanEnv(process.env);
  return new Promise((resolve) => {
    const shell = base.SHELL || '/bin/zsh';
    execFile(shell, ['-ilc', `printf '%s' ${ENV_MARK}; /usr/bin/env -0`], { env: base, timeout: 8000, maxBuffer: 8 << 20 }, (_err, out) => {
      resolve(parseEnvProbe(out ?? '') ?? { ...base, PATH: [base.PATH, ...FALLBACK_PATH].filter(Boolean).join(':') });
    });
  });
}

class Agents extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir      folder for agent-sessions.json (the app's userData)
   * @param {number} o.port     the office's port – the session's hooks report here
   * @param {string} [o.bin]    claude executable (default: found on the login shell's PATH)
   * @param {string} [o.projectsDir] Claude Code transcripts (default ~/.claude/projects)
   * @param {object} [o.env]    environment of session processes (default: a login shell's, see loginEnv)
   */
  constructor({ dir, port, bin = process.env.AI_OFFICE_CLAUDE_BIN, projectsDir = path.join(os.homedir(), '.claude', 'projects'), env = null }) {
    super();
    this.file = path.join(dir, 'agent-sessions.json');
    this.port = port;
    this.bin = bin || null;
    this.projectsDir = projectsDir;
    this.envPromise = env ? Promise.resolve(env) : null;
    /** @type {Map<string, {id: string, cwd: string, project: string, title: string, createdAt: number, lastActive: number, cost: number}>} */
    this.meta = new Map();
    /** @type {Map<string, {conv: object, proc: import('node:child_process').ChildProcess|null, costBase: number, stderr: string, stopTimer: any, ending: boolean, seq: number}>} */
    this.live = new Map();
    this.saveTimer = null;
    try {
      for (const m of JSON.parse(fs.readFileSync(this.file, 'utf8')).sessions ?? []) if (UUID.test(m.id)) this.meta.set(m.id, m);
    } catch { /* first run */ }
  }

  has(id) {
    return this.meta.has(id);
  }

  summary(id) {
    const m = this.meta.get(id);
    if (!m) return null;
    const l = this.live.get(id);
    return {
      ...m,
      title: l?.conv.title || m.title,
      running: Boolean(l?.proc),
      busy: Boolean(l?.conv.busy),
      activity: l?.conv.activity ?? '',
      summary: l?.conv.summary || m.summary || '',
      mode: l?.conv.mode ?? null,
    };
  }

  /** All sessions, most recently active first. */
  list() {
    return [...this.meta.values()].sort((a, b) => b.lastActive - a.lastActive).map((m) => this.summary(m.id));
  }

  /** Summary and every item of a session (loaded from its transcript after a restart). */
  open(id) {
    if (!this.meta.has(id)) return null;
    const l = this.conversation(id);
    return { ...this.summary(id), items: l.conv.items, seq: l.seq };
  }

  conversation(id) {
    let l = this.live.get(id);
    if (!l) {
      const file = findTranscript(this.projectsDir, id, this.meta.get(id)?.cwd);
      let conv = createConversation();
      if (file) {
        try {
          conv = fromTranscript(fs.readFileSync(file, 'utf8'));
        } catch { /* unreadable – start empty */ }
      }
      l = { conv, proc: null, costBase: 0, stderr: '', stopTimer: null, ending: false, seq: 0 };
      this.live.set(id, l);
    }
    return l;
  }

  /** New session in `cwd` with a first message; returns its id. */
  async create({ cwd, prompt }) {
    const dir = path.resolve(String(cwd ?? ''));
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Složka neexistuje: ${dir}`);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.meta.set(id, {
      id, cwd: dir, project: basename(projectRoot(dir)) || basename(dir), title: oneLine(prompt, 60), createdAt: now, lastActive: now, cost: 0,
    });
    this.save();
    await this.send(id, prompt);
    return id;
  }

  /** Your message to a session; starts (or resumes) its process when it isn't running. Queued while Claude works. */
  async send(id, text) {
    const m = this.meta.get(id);
    const t = String(text ?? '').trim();
    if (!m || !t) return false;
    const l = this.conversation(id);
    this.emitChanged(id, l, addUser(l.conv, t));
    l.conv.busy = true;
    m.lastActive = Date.now();
    m.title ||= l.conv.title;
    this.save();
    this.emit('state', this.summary(id));
    if (!l.proc) await this.start(id, l);
    l.proc?.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`);
    return true;
  }

  /** Interrupts the current turn; the session stays open. Kills the process when Claude doesn't react. */
  stop(id) {
    const l = this.live.get(id);
    if (!l?.proc || !l.conv.busy) return false;
    l.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
    clearTimeout(l.stopTimer);
    l.stopTimer = setTimeout(() => {
      if (l.proc && l.conv.busy) l.proc.kill('SIGTERM');
    }, STOP_GRACE_MS).unref();
    return true;
  }

  /** Ends the session's process (the employee goes home). The conversation can be continued later. */
  dismiss(id) {
    const l = this.live.get(id);
    if (!l?.proc) return false;
    l.ending = true;
    const proc = l.proc;
    proc.stdin.end();
    setTimeout(() => { if (l.proc === proc) proc.kill('SIGTERM'); }, STOP_GRACE_MS).unref();
    return true;
  }

  /** On quit: every session process ends (they resume next time you write to them). */
  shutdown() {
    for (const l of this.live.values()) {
      if (!l.proc) continue;
      l.ending = true;
      l.proc.stdin.end();
      l.proc.kill('SIGTERM');
    }
    this.flush();
  }

  async start(id, l) {
    const m = this.meta.get(id);
    this.envPromise ??= loginEnv();
    const env = { ...(await this.envPromise), AI_OFFICE_PORT: String(this.port) };
    const bin = this.bin ?? findOnPath('claude', env.PATH) ?? path.join(os.homedir(), '.local', 'bin', 'claude');
    // a session whose transcript exists already talked to Claude → resume it; otherwise it gets our id
    const resume = Boolean(findTranscript(this.projectsDir, id, m.cwd));
    let proc;
    try {
      proc = spawn(bin, buildArgs({ id, resume }), { cwd: m.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.fail(id, l, `Nepodařilo se spustit claude (${bin}): ${err.message}`);
      return;
    }
    l.proc = proc;
    l.ending = false;
    l.stderr = '';
    l.costBase = m.cost ?? 0;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.onLine(id, l, line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { l.stderr = (l.stderr + chunk).slice(-2000); });
    proc.stdin.on('error', () => { /* process already gone – reported by 'exit' */ });
    proc.on('error', (err) => {
      if (l.proc === proc) l.proc = null;
      this.fail(id, l, `Nepodařilo se spustit claude (${bin}): ${err.message}`);
    });
    proc.on('exit', (code, signal) => {
      if (l.proc !== proc) return;
      l.proc = null;
      clearTimeout(l.stopTimer);
      if (l.conv.busy || (code && !l.ending)) {
        const why = oneLine(l.stderr, 300);
        this.fail(id, l, `Claude skončil (${signal ?? `kód ${code}`})${why ? `: ${why}` : ''}`);
      } else {
        this.emit('state', this.summary(id));
      }
    });
  }

  fail(id, l, text) {
    const changed = [];
    settle(l.conv, changed);
    addNotice(l.conv, 'error', text, changed);
    l.conv.busy = false;
    l.conv.activity = '';
    this.emitChanged(id, l, changed);
    this.emit('state', this.summary(id));
  }

  onLine(id, l, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'rate_limit_event') {
      const rl = rateLimits(msg);
      if (rl) this.emit('status', { session_id: id, rate_limits: rl });
      return;
    }
    if (msg.type === 'control_request') {
      // nothing is routed to us (no --permission-prompt-tool), but never leave Claude waiting for an answer
      const response = { subtype: 'error', request_id: msg.request_id, error: 'AI Office tohle zatím neumí' };
      l.proc?.stdin.write(`${JSON.stringify({ type: 'control_response', response })}\n`);
      return;
    }
    const before = `${l.conv.busy}|${l.conv.activity}|${l.conv.summary}|${l.conv.mode}`;
    this.emitChanged(id, l, apply(l.conv, msg));
    if (msg.type === 'result') {
      clearTimeout(l.stopTimer);
      const m = this.meta.get(id);
      if (m && Number.isFinite(msg.total_cost_usd)) {
        m.cost = l.costBase + msg.total_cost_usd; // the process reports its own running total
        this.emit('status', { session_id: id, cost: { total_cost_usd: m.cost } });
      }
      if (m) {
        m.lastActive = Date.now();
        m.summary = l.conv.summary;
        this.save();
      }
    }
    if (`${l.conv.busy}|${l.conv.activity}|${l.conv.summary}|${l.conv.mode}` !== before) this.emit('state', this.summary(id));
  }

  /** Item updates carry a sequence number: the renderer skips the ones already contained in what open() gave it. */
  emitChanged(id, l, changed) {
    for (const index of changed) {
      l.seq += 1;
      this.emit('item', { id, index, item: l.conv.items[index], seq: l.seq });
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1000).unref();
  }

  flush() {
    clearTimeout(this.saveTimer);
    try {
      fs.writeFileSync(this.file, JSON.stringify({ sessions: [...this.meta.values()] }, null, 1));
    } catch (err) {
      console.error(`[ai-office] agents: ${err.message}`);
    }
  }
}

module.exports = { Agents, buildArgs, cleanEnv, parseEnvProbe, findOnPath, findTranscript, projectDirName };
