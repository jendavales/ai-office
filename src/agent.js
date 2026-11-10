'use strict';
/**
 * Claude Code sessions run by AI Office itself – the way Claude desktop runs them: one
 * `claude -p --input-format stream-json --output-format stream-json` process per session, your messages
 * go in over stdin, Claude's replies stream back as JSON lines. It is the official CLI with its own login,
 * so it runs on your subscription, and your hooks keep the office in sync like with any other session.
 *
 * Conversations AI Office didn't start (Claude desktop, terminals) open read-only from their transcript;
 * writing to one forks it into a session of ours (`fork`), the same way `claude --resume --fork-session`
 * does: a copy of the transcript under a new id. Rewinding is a fork cut before one of your messages.
 *
 * Events: 'item' { id, index, item, seq } · 'state' summary · 'status' (status-line shaped: cost, rate limits)
 *         'title' { id, title } (a name AI Office made up for a session) · 'turn' { id } (a turn ended)
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
const FOREIGN_CACHE = 6; // conversations of other apps kept parsed in memory
const TITLE_MODEL = 'haiku';
const TITLE_TIMEOUT_MS = 60_000;

/** Model aliases offered in the UI; a full model id (claude-…) is accepted too. '' = your Claude Code setting. */
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const validModel = (m) => (m && (MODELS.includes(m) || /^claude-[a-z0-9.[\]-]+$/i.test(m)) ? String(m) : null);
const validEffort = (e) => (EFFORTS.includes(e) ? e : null);

/** Arguments of one session process. The permission mode is left to your Claude Code settings. */
function buildArgs({ id, resume, model = null, effort = null }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    resume ? '--resume' : '--session-id', id,
  ];
  if (validModel(model)) args.push('--model', model);
  if (validEffort(effort)) args.push('--effort', effort);
  return args;
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
 * A copy of a transcript under a new session id – what `claude --resume --fork-session` writes – optionally
 * cut before the entry `cutUuid` (rewind). Returns the kept lines; empty when nothing was said before the cut.
 */
function forkTranscript(text, fromId, toId, cutUuid = null) {
  const kept = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    if (cutUuid && line.includes(`"uuid":"${cutUuid}"`)) {
      try {
        if (JSON.parse(line).uuid === cutUuid) break;
      } catch { /* not the one */ }
    }
    kept.push(line.split(`"sessionId":"${fromId}"`).join(`"sessionId":"${toId}"`));
  }
  try {
    if (kept.length) JSON.parse(kept.at(-1));
  } catch {
    kept.pop(); // torn last line of a conversation that is being written right now
  }
  const said = kept.some((l) => l.includes('"type":"user"') || l.includes('"type":"assistant"'));
  return said ? kept : [];
}

/** Prompt for a session's name, from its first exchange (whatever language the conversation is in). */
function titlePrompt(userText, assistantText) {
  return [
    'Vymysli krátký název této konverzace (3 až 6 slov) ve stejném jazyce, jakým píše uživatel.',
    'Odpověz pouze názvem – bez uvozovek, bez tečky na konci, bez vysvětlení.',
    '', '--- Uživatel ---', oneLine(userText, 1500), '', '--- Asistent ---', oneLine(assistantText, 800),
  ].join('\n');
}

// "Název: …", "Title: …", "Název konverzace: …" – a label the small model sometimes puts before the name
const TITLE_LABEL = /^(?:(?:návrh\s+)?(?:název|titulek)(?:\s+konverzace)?|(?:conversation\s+)?title)\s*:\s*/iu;
const TITLE_WRAP = /^["'`*„“”‚‘’«»]+|["'`*„“”‚‘’«».]+$/gu;

/** The name the small model came up with: one line without a label, wrapping quotes and a full stop; at most 80 characters. */
function cleanTitle(text) {
  const unwrap = (s) => s.replace(TITLE_WRAP, '').trim();
  return unwrap(unwrap(oneLine(text, 400)).replace(TITLE_LABEL, '')).slice(0, 80).trim();
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
   * @param {boolean} [o.naming] make up a title for new sessions with a small model (default true)
   */
  constructor({ dir, port, bin = process.env.AI_OFFICE_CLAUDE_BIN, projectsDir = path.join(os.homedir(), '.claude', 'projects'), env = null, naming = true }) {
    super();
    this.file = path.join(dir, 'agent-sessions.json');
    this.port = port;
    this.bin = bin || null;
    this.projectsDir = projectsDir;
    this.naming = naming;
    this.envPromise = env ? Promise.resolve(env) : null;
    /** @type {Map<string, {id: string, cwd: string, project: string, title: string, createdAt: number, lastActive: number, cost: number, model: string|null, effort: string|null, forkOf?: string, named?: boolean}>} */
    this.meta = new Map();
    /** @type {Map<string, {conv: object, proc: import('node:child_process').ChildProcess|null, costBase: number, stderr: string, stopTimer: any, ending: boolean, restart: boolean, naming: boolean, seq: number}>} */
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
      id, cwd: m.cwd, project: m.project, createdAt: m.createdAt, lastActive: m.lastActive, cost: m.cost ?? 0, forkOf: m.forkOf ?? null,
      title: l?.conv.title || m.title,
      running: Boolean(l?.proc),
      busy: Boolean(l?.conv.busy),
      activity: l?.conv.activity ?? '',
      summary: l?.conv.summary || m.summary || '',
      mode: l?.conv.mode ?? null,
      model: m.model ?? null,
      effort: m.effort ?? null,
      liveModel: l?.conv.model ?? null,
      managed: true,
    };
  }

  /** All sessions, most recently active first. */
  list() {
    return [...this.meta.values()].sort((a, b) => b.lastActive - a.lastActive).map((m) => this.summary(m.id));
  }

  /**
   * Summary and every item of a conversation: a session of ours (loaded from its transcript after a restart),
   * or any other transcript (`file`, `cwd` from the index) – read-only until written to, which forks it.
   */
  async open(id, { file = null, cwd = null } = {}) {
    const m = this.meta.get(id);
    if (!m && !file) return null;
    const l = await this.conversation(id, file);
    const dir = cwd ?? '';
    const base = m ? this.summary(id) : {
      id, cwd: dir, project: basename(projectRoot(dir)) || basename(dir), title: l.conv.title, createdAt: null, lastActive: l.mtime ?? null, cost: 0,
      running: false, busy: false, activity: '', summary: '', mode: null, model: null, effort: null, liveModel: l.conv.model, managed: false,
    };
    return { ...base, customTitle: l.conv.customTitle || l.conv.agentName || l.conv.aiTitle || '', items: l.conv.items, seq: l.seq };
  }

  /**
   * The live state of a conversation, loaded from its transcript the first time. A conversation of another app
   * is read again when its transcript changed since (Claude desktop or a terminal may have continued it).
   */
  async conversation(id, file = null) {
    const own = this.meta.has(id);
    const cached = this.live.get(id);
    if (cached && own) return cached;
    const transcript = file ?? cached?.file ?? findTranscript(this.projectsDir, id, this.meta.get(id)?.cwd);
    const st = transcript ? await fs.promises.stat(transcript).catch(() => null) : null;
    if (cached && (!st || (cached.mtime === st.mtimeMs && cached.size === st.size))) {
      this.live.delete(id); // most recently used last
      this.live.set(id, cached);
      return cached;
    }
    let conv = createConversation();
    if (st) {
      try {
        conv = fromTranscript(await fs.promises.readFile(transcript, 'utf8'));
      } catch { /* unreadable – start empty */ }
    }
    const won = this.live.get(id); // a parallel open() may have won while we read
    if (won && won !== cached) return won;
    const l = {
      conv, file: transcript, mtime: st?.mtimeMs ?? null, size: st?.size ?? null,
      proc: null, ready: null, costBase: 0, stderr: '', stopTimer: null, ending: false, restart: false, naming: false, seq: 0,
    };
    this.live.delete(id);
    this.live.set(id, l);
    if (!this.meta.has(id)) this.evictForeign();
    return l;
  }

  /** Conversations of other apps are only cached a few at a time, least recently opened go first (transcripts run to megabytes). */
  evictForeign() {
    const foreign = [...this.live.keys()].filter((id) => !this.meta.has(id));
    for (const id of foreign.slice(0, Math.max(0, foreign.length - FOREIGN_CACHE))) this.live.delete(id);
  }

  /** New session in `cwd` with a first message; returns its id. */
  async create({ cwd, prompt, model = null, effort = null }) {
    const dir = path.resolve(String(cwd ?? ''));
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Složka neexistuje: ${dir}`);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.meta.set(id, {
      id, cwd: dir, project: basename(projectRoot(dir)) || basename(dir), title: oneLine(prompt, 60), createdAt: now, lastActive: now, cost: 0,
      model: validModel(model), effort: validEffort(effort),
    });
    this.save();
    await this.send(id, prompt);
    return id;
  }

  /**
   * A copy of a conversation as a new session of ours, like `claude --resume --fork-session`: of a session of
   * ours or of any transcript (`file`, `cwd`). With `before`, the copy stops short of your message with that
   * ordinal (0 = the first) – a rewind; `before` past the last message copies everything.
   */
  async fork({ id, before = null, cwd = null, file = null, model = null, effort = null }) {
    const m = this.meta.get(id);
    const dir = m?.cwd ?? cwd;
    if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Složka projektu už neexistuje: ${dir ?? '?'}`);
    const src = file ?? findTranscript(this.projectsDir, id, dir);
    const text = src ? await fs.promises.readFile(src, 'utf8') : '';
    let cutUuid = null;
    if (before != null) {
      const users = fromTranscript(text).items.filter((i) => i.kind === 'user');
      const target = users[before];
      if (target) {
        if (!target.uuid) throw new Error('Tuhle zprávu nejde v přepisu najít.');
        cutUuid = target.uuid;
      }
    }
    const newId = crypto.randomUUID();
    const lines = forkTranscript(text, id, newId, cutUuid);
    if (lines.length) {
      const out = path.join(this.projectsDir, projectDirName(dir), `${newId}.jsonl`);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      await fs.promises.writeFile(out, `${lines.join('\n')}\n`);
    }
    const now = Date.now();
    this.meta.set(newId, {
      id: newId, cwd: dir, project: m?.project ?? (basename(projectRoot(dir)) || basename(dir)), title: m?.title ?? '', createdAt: now, lastActive: now, cost: 0,
      model: validModel(model ?? m?.model), effort: validEffort(effort ?? m?.effort), forkOf: id, named: true,
    });
    this.save();
    this.emitState(newId);
    return newId;
  }

  /** Model and effort of a session; a running process picks them up when it next starts (after its current turn). */
  setOptions(id, { model, effort } = {}) {
    const m = this.meta.get(id);
    if (!m) return null;
    if (model !== undefined) m.model = validModel(model);
    if (effort !== undefined) m.effort = validEffort(effort);
    this.save();
    const l = this.live.get(id);
    if (l?.proc) {
      if (l.conv.busy) l.restart = true;
      else this.dismiss(id);
    }
    const s = this.summary(id);
    this.emit('state', s);
    return s;
  }

  /** Every 'state' goes through here: a session forgotten meanwhile (rewound) has none. */
  emitState(id) {
    const s = this.summary(id);
    if (s) this.emit('state', s);
  }

  /** Your message to a session; starts (or resumes) its process when it isn't running. Queued while Claude works. */
  async send(id, text) {
    const m = this.meta.get(id);
    const t = String(text ?? '').trim();
    if (!m || !t) return false;
    const l = await this.conversation(id);
    this.emitChanged(id, l, addUser(l.conv, t));
    l.conv.busy = true;
    m.lastActive = Date.now();
    m.title ||= l.conv.title;
    this.save();
    this.emitState(id);
    // messages go out in the order they were sent, each once a process is there to take it
    const ready = (l.ready ?? Promise.resolve()).then(() => this.ensureProcess(id, l)).catch(() => {});
    l.ready = ready;
    await ready;
    if (l.ready === ready) l.ready = null;
    if (this.meta.has(id)) l.proc?.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`);
    return true;
  }

  /** A process that takes messages: a closing one (dismissed, options changed) is let go first, then a new one starts. */
  async ensureProcess(id, l) {
    if (l.proc && l.ending) {
      const proc = l.proc;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, STOP_GRACE_MS * 2);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (l.proc === proc) l.proc = null; // didn't go away even when killed – leave it be
    }
    if (!l.proc && this.meta.has(id)) await this.start(id, l);
  }

  /** Interrupts the current turn; the session stays open. Kills the process when Claude doesn't react. */
  stop(id) {
    const l = this.live.get(id);
    if (!l?.proc || !l.conv.busy) return false;
    l.proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
    clearTimeout(l.stopTimer);
    const proc = l.proc;
    l.stopTimer = setTimeout(() => {
      if (l.proc === proc && l.conv.busy) proc.kill('SIGTERM');
    }, STOP_GRACE_MS).unref();
    return true;
  }

  /** Ends the session's process (the employee goes home). The conversation can be continued later. */
  dismiss(id) {
    const l = this.live.get(id);
    if (!l?.proc) return false;
    l.ending = true;
    l.restart = false;
    const proc = l.proc;
    proc.stdin.end();
    setTimeout(() => { if (l.proc === proc) proc.kill('SIGTERM'); }, STOP_GRACE_MS).unref();
    return true;
  }

  /** Drops a session from ours (after a rewind); its transcript stays on disk. */
  forget(id) {
    if (!this.meta.has(id)) return false;
    this.dismiss(id);
    this.meta.delete(id);
    this.live.delete(id);
    this.save();
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

  async env() {
    this.envPromise ??= loginEnv();
    return { ...(await this.envPromise), AI_OFFICE_PORT: String(this.port) };
  }

  claudeBin(env) {
    return this.bin ?? findOnPath('claude', env.PATH) ?? path.join(os.homedir(), '.local', 'bin', 'claude');
  }

  async start(id, l) {
    const env = await this.env();
    const m = this.meta.get(id);
    if (!m) return; // forgotten meanwhile
    const bin = this.claudeBin(env);
    // a session whose transcript exists already talked to Claude → resume it; otherwise it gets our id
    const resume = Boolean(findTranscript(this.projectsDir, id, m.cwd));
    let proc;
    try {
      proc = spawn(bin, buildArgs({ id, resume, model: m.model, effort: m.effort }), { cwd: m.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.fail(id, l, `Nepodařilo se spustit claude (${bin}): ${err.message}`);
      return;
    }
    l.proc = proc;
    l.ending = false;
    l.restart = false;
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
      const handedOver = l.ending && l.ready; // closed on purpose while your next message waits for a new process
      if (!handedOver && (l.conv.busy || (code && !l.ending))) {
        const why = oneLine(l.stderr, 300);
        this.fail(id, l, `Claude skončil (${signal ?? `kód ${code}`})${why ? `: ${why}` : ''}`);
      } else {
        this.emitState(id);
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
    this.emitState(id);
  }

  onLine(id, l, line) {
    if (!this.meta.has(id)) return; // forgotten (rewound) – its process is on its way out
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
    const before = `${l.conv.busy}|${l.conv.activity}|${l.conv.summary}|${l.conv.mode}|${l.conv.model}`;
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
        if (l.restart) this.dismiss(id); // model or effort changed mid-turn: next message starts a fresh process
        if (!m.named && !msg.is_error) this.nameSession(id, l);
      }
      this.emit('turn', { id });
    }
    if (`${l.conv.busy}|${l.conv.activity}|${l.conv.summary}|${l.conv.mode}|${l.conv.model}` !== before) this.emitState(id);
  }

  /** A title for a session from its first exchange, made up by a small model in the background. */
  async nameSession(id, l) {
    const m = this.meta.get(id);
    if (!this.naming || !m || l.naming) return;
    const userText = l.conv.items.find((i) => i.kind === 'user')?.text;
    const reply = l.conv.items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n');
    if (!userText || !reply.trim()) return;
    l.naming = true;
    m.nameTries = (m.nameTries ?? 0) + 1;
    if (m.nameTries >= 2) m.named = true; // one more go at most
    try {
      const env = await this.env();
      const title = await new Promise((resolve, reject) => {
        const args = ['-p', '--model', TITLE_MODEL, '--effort', 'low', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--output-format', 'text'];
        const proc = spawn(this.claudeBin(env), args, { cwd: m.cwd, env: { ...env, AI_OFFICE_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (c) => { out += c; });
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (c) => { err = (err + c).slice(-500); });
        proc.on('error', reject);
        proc.on('exit', (code) => (code ? reject(new Error(oneLine(err, 200) || `kód ${code}`)) : resolve(out)));
        proc.stdin.on('error', () => {});
        proc.stdin.end(titlePrompt(userText, reply));
        setTimeout(() => proc.kill('SIGTERM'), TITLE_TIMEOUT_MS).unref();
      });
      const clean = cleanTitle(title);
      if (!clean) throw new Error('prázdná odpověď');
      m.named = true;
      this.save();
      this.emit('title', { id, title: clean });
    } catch (err) {
      console.error(`[ai-office] název konverzace: ${err.message}`);
    } finally {
      l.naming = false;
    }
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

module.exports = { Agents, MODELS, EFFORTS, buildArgs, cleanEnv, cleanTitle, parseEnvProbe, findOnPath, findTranscript, forkTranscript, projectDirName, titlePrompt, validModel, validEffort };
