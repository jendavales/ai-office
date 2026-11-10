'use strict';
/**
 * Every Claude Code conversation on this machine as one list – the ones AI Office ran, the ones from Claude
 * desktop and from terminals: an index of ~/.claude/projects/<project>/<session>.jsonl with id, folder,
 * project, title, when, the model of the last reply, and the prompts (for search). Nothing is read in full more
 * than once: a transcript is re-read only when its size or mtime changed (the first scan of a few thousand
 * transcripts takes seconds and runs in the background), the result is cached in conversations.json.
 *
 * Titles, best first: renamed by you · Claude desktop's `custom-title` · Claude Code's `agent-name` ·
 * Claude Code's automatic `ai-title` · AI Office's own naming (auto) · an older `summary` entry · the first prompt.
 * Archived and hidden (rewound) conversations are remembered in the same file.
 *
 * Events: 'update' (something in the list changed)
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { basename, oneLine, projectRoot } = require('./hook-events');
const { isTemp } = require('./history');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPTS = 30;
const PROMPT_CHARS = 200;
const RESCAN_MS = 30_000;
const VERSION = 2; // of what readTranscript keeps – older entries are read again (your titles, archive etc. stay)

// whole message wrapped in one tag: slash-command echoes, local command output – not something you wrote
const WRAPPED = /^<([a-z][\w-]*)>[\s\S]*<\/\1>\s*$/;

/** Text you typed in a user entry, or '' for tool results, command echoes and the like. */
function promptText(content) {
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return '';
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || WRAPPED.test(text) || /^\[Request interrupted/.test(text)) return '';
  return text;
}

/** Lower case without diacritics, for search. */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** What one transcript is about – streamed, only the lines that matter are parsed. */
async function readTranscript(file) {
  const info = {
    cwd: null, entrypoint: null, firstPrompt: '', prompts: [], customTitle: '', agentName: '', aiTitle: '', summary: '', model: null,
    createdAt: null, lastActive: null, turns: 0,
  };
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const tagged = line.includes('"type":"custom-title"') || line.includes('"type":"agent-name"') || line.includes('"type":"ai-title"')
        || line.includes('"type":"summary"');
      if (!tagged && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // torn last line while Claude is writing
      }
      if (e.type === 'custom-title') {
        if (typeof e.customTitle === 'string') info.customTitle = oneLine(e.customTitle, 120);
      } else if (e.type === 'agent-name') {
        if (typeof e.agentName === 'string') info.agentName = oneLine(e.agentName, 120);
      } else if (e.type === 'ai-title') {
        if (typeof e.aiTitle === 'string') info.aiTitle = oneLine(e.aiTitle, 120);
      } else if (e.type === 'summary') {
        if (typeof e.summary === 'string') info.summary = oneLine(e.summary, 120);
      } else if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain) {
        const ts = Date.parse(e.timestamp);
        if (Number.isFinite(ts)) {
          info.createdAt ??= ts;
          info.lastActive = Math.max(info.lastActive ?? 0, ts);
        }
        info.cwd ??= typeof e.cwd === 'string' ? e.cwd : null;
        info.entrypoint ??= typeof e.entrypoint === 'string' ? e.entrypoint : null;
        if (e.type === 'assistant') {
          if (e.message?.stop_reason === 'end_turn') info.turns += 1;
          const model = e.message?.model;
          if (typeof model === 'string' && model && model !== '<synthetic>') info.model = model; // not Claude Code's own notes
        } else if (!e.isMeta && !e.isCompactSummary) {
          const text = promptText(e.message?.content);
          if (!text) continue;
          info.firstPrompt ||= oneLine(text, 120);
          if (info.prompts.length < MAX_PROMPTS) info.prompts.push(oneLine(text, PROMPT_CHARS));
        }
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return info;
}

/** Session transcripts: <projects>/<project dir>/<uuid>.jsonl (subagents live one level deeper, as agent-*.jsonl). */
async function listTranscripts(root) {
  const files = [];
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl') && UUID.test(e.name.slice(0, -6))) files.push(path.join(root, d.name, e.name));
    }
  }
  return files;
}

const sourceOf = (entrypoint) => {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (/^sdk/.test(entrypoint ?? '')) return 'sdk';
  return 'cli';
};

class Conversations extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir                folder for conversations.json (the app's userData)
   * @param {string} [o.projectsDir]      Claude Code transcripts (default ~/.claude/projects)
   */
  constructor({ dir, projectsDir = path.join(os.homedir(), '.claude', 'projects') }) {
    super();
    this.file = path.join(dir, 'conversations.json');
    this.projectsDir = projectsDir;
    /** @type {Map<string, object>} transcript path → what readTranscript found (+ id, mtime, size) */
    this.files = new Map();
    /** @type {Map<string, string>} id → transcript path */
    this.paths = new Map();
    this.titles = {}; // id → title you chose
    this.auto = {}; // id → title AI Office made up
    this.archived = {}; // id → when
    this.hidden = {}; // id → when (rewound originals)
    this.timer = null;
    this.saveTimer = null;
    this.scanning = null;
    this.scanned = false;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version === VERSION) for (const [file, info] of Object.entries(data.files ?? {})) this.remember(file, info);
      Object.assign(this, { titles: data.titles ?? {}, auto: data.auto ?? {}, archived: data.archived ?? {}, hidden: data.hidden ?? {} });
    } catch { /* first run */ }
  }

  remember(file, info) {
    this.files.set(file, info);
    this.paths.set(info.id, file);
  }

  forget(file) {
    const info = this.files.get(file);
    if (!info) return;
    this.files.delete(file);
    if (this.paths.get(info.id) === file) this.paths.delete(info.id);
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), RESCAN_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }

  /** Re-reads transcripts that are new or changed since the last scan, drops the gone ones. */
  scan() {
    this.scanning ??= this.doScan()
      .catch((err) => console.error(`[ai-office] conversations: ${err.message}`))
      .finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async doScan() {
    const files = await listTranscripts(this.projectsDir);
    const seen = new Set(files);
    let changed = false;
    for (const file of this.files.keys()) {
      if (seen.has(file)) continue;
      this.forget(file);
      changed = true;
    }
    let sinceEmit = 0;
    for (const file of files) {
      if (await this.refresh(file)) {
        changed = true;
        sinceEmit += 1;
        if (!this.scanned && sinceEmit >= 100) { // the first scan: let the list fill up as it goes
          sinceEmit = 0;
          this.emit('update');
        }
      }
    }
    this.scanned = true;
    if (changed) {
      this.save();
      this.emit('update');
    }
  }

  /** Reads one transcript when its stat changed; resolves with whether anything changed. */
  async refresh(file) {
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return false;
    }
    const known = this.files.get(file);
    if (known && known.mtime === st.mtimeMs && known.size === st.size) return false;
    let info;
    try {
      info = await readTranscript(file);
    } catch {
      return false;
    }
    const id = path.basename(file, '.jsonl');
    this.remember(file, { ...info, id, mtime: st.mtimeMs, size: st.size, lastActive: info.lastActive ?? st.mtimeMs });
    return true;
  }

  /** Re-reads the transcript of one session now (after a turn in a session AI Office runs). */
  async touch(id) {
    const file = this.paths.get(id) ?? this.find(id);
    if (!file) return false;
    const changed = await this.refresh(file);
    if (changed) {
      this.save();
      this.emit('update');
    }
    return changed;
  }

  /** Transcript of a session not indexed yet (just created). */
  find(id) {
    if (!UUID.test(id)) return null;
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.projectsDir);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const file = path.join(this.projectsDir, d, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  fileOf(id) {
    return this.paths.get(id) ?? null;
  }

  isHidden(id) {
    return Boolean(this.hidden[id]);
  }

  isArchived(id) {
    return Boolean(this.archived[id]);
  }

  /** The best title known for a session, or null when only the first prompt would do. */
  titleOf(id) {
    const info = this.files.get(this.paths.get(id));
    return this.titles[id] || info?.customTitle || info?.agentName || info?.aiTitle || this.auto[id] || info?.summary || null;
  }

  /** Summary of one indexed session (sessions AI Office runs may not have a transcript yet – see main.js). */
  get(id) {
    const file = this.paths.get(id);
    const info = file && this.files.get(file);
    if (!info) return null;
    return this.summary(info);
  }

  summary(info) {
    const cwd = info.cwd ?? '';
    const projectPath = projectRoot(cwd) || cwd;
    return {
      id: info.id,
      cwd,
      projectPath,
      project: basename(projectPath) || basename(cwd) || '?',
      title: this.titleOf(info.id) || info.firstPrompt || 'Bez názvu',
      createdAt: info.createdAt ?? info.mtime,
      lastActive: info.lastActive,
      turns: info.turns,
      lastModel: info.model ?? null, // `model` of a session of ours is the one picked for it
      source: sourceOf(info.entrypoint),
      archived: this.isArchived(info.id),
    };
  }

  /** Worth listing: has a prompt, isn't hidden or from a temp folder, and is the transcript this id maps to. */
  listed(file, info) {
    return info.prompts.length > 0 && !this.hidden[info.id] && Boolean(info.cwd) && !isTemp(info.cwd) && this.paths.get(info.id) === file;
  }

  /** Every conversation worth listing, most recent first. */
  list() {
    const out = [];
    for (const [file, info] of this.files) {
      if (!this.listed(file, info)) continue;
      out.push(this.summary(info));
    }
    return out.sort((a, b) => b.lastActive - a.lastActive);
  }

  /** Conversations whose title, project or prompts contain every word of `q`, most recent first; with the matching prompt as a snippet. */
  search(q) {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits = [];
    for (const [file, info] of this.files) {
      if (!this.listed(file, info)) continue;
      const s = this.summary(info);
      const texts = [s.title, s.project, ...info.prompts];
      const all = fold(texts.join('\n'));
      if (!words.every((w) => all.includes(w))) continue;
      const prompt = info.prompts.find((p) => words.some((w) => fold(p).includes(w)));
      hits.push({ id: info.id, snippet: prompt && fold(s.title) !== fold(prompt) ? snippet(prompt, words[0]) : '', at: s.lastActive });
    }
    return hits.sort((a, b) => b.at - a.at).map(({ id, snippet: text }) => ({ id, snippet: text }));
  }

  rename(id, title) {
    const t = oneLine(title, 120);
    if (t) this.titles[id] = t;
    else delete this.titles[id];
    this.save();
    this.emit('update');
  }

  setAuto(id, title) {
    const t = oneLine(title, 120);
    if (!t) return;
    this.auto[id] = t;
    this.save();
    this.emit('update');
  }

  archive(id, on = true) {
    if (on) this.archived[id] = Date.now();
    else delete this.archived[id];
    this.save();
    this.emit('update');
  }

  /** A conversation that was rewound lives on as a new one; the original stays on disk but out of the list. */
  hide(id) {
    this.hidden[id] = Date.now();
    this.save();
    this.emit('update');
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    const data = { version: VERSION, files: Object.fromEntries(this.files), titles: this.titles, auto: this.auto, archived: this.archived, hidden: this.hidden };
    try {
      fs.writeFileSync(this.file, JSON.stringify(data));
    } catch (err) {
      console.error(`[ai-office] conversations: ${err.message}`);
    }
  }
}

/** The part of a prompt around the first match, for the search results. */
function snippet(text, word) {
  const at = fold(text).indexOf(word);
  if (at < 0) return oneLine(text, 90);
  const start = Math.max(0, at - 30);
  return `${start ? '…' : ''}${oneLine(text.slice(start, start + 90), 90)}${start + 90 < text.length ? '…' : ''}`;
}

module.exports = { Conversations, readTranscript, promptText, fold, sourceOf };
