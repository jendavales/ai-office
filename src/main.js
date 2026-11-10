'use strict';
/**
 * AI Office – Electron main process.
 *  - HTTP endpoint (127.0.0.1:4747/event) receiving Claude Code hook payloads
 *  - process scanner for other AI CLIs (Codex, Gemini, Aider, …)
 *  - session state, office window, menu-bar tray + popover
 */
const { app, BrowserWindow, Tray, Menu, Notification, dialog, nativeImage, ipcMain, safeStorage, screen, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Agents, EFFORTS, MODELS } = require('./agent');
const { Conversations } = require('./conversations');
const { demoScript } = require('./demo');
const { Store } = require('./store');
const { Todoist } = require('./todoist');
const { focusTty } = require('./focus');
const { scanHistory } = require('./history');
const { basename, normalize, projectRoot, sessionKey, toolCategory } = require('./hook-events');

const PORT = Number(process.env.AI_OFFICE_PORT) || 4747;
const STALE_MS = 3 * 60 * 60 * 1000; // session without any event for 3 h → goes home
const SCAN_MS = 5000;
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');

/** @type {Map<string, object>} */
const sessions = new Map();
let mainWin = null;
let popWin = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- prefs

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = { sound: true, notify: true };
/** @type {Store} */
let store = null;
/** @type {Agents} sessions AI Office runs itself (conversation panel) */
let agents = null;
/** @type {Conversations} every Claude Code conversation on this machine (desktop, terminals, ours) */
let conversations = null;
/** @type {Todoist} the director's to-do list */
let todoist = null;

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch { /* first run */ }
}

function setPref(key, value) {
  prefs[key] = value;
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (err) {
    console.error(`[ai-office] prefs: ${err.message}`);
  }
  broadcast('office:settings', prefs);
}

// ---------------------------------------------------------------- events

function applyToSession(ev) {
  if (ev.type === 'leave') {
    const gone = sessions.get(ev.sessionId);
    if (gone?.workStart) store.recordWork(gone.key, ev.ts - gone.workStart);
    sessions.delete(ev.sessionId);
    return null;
  }
  let s = sessions.get(ev.sessionId);
  if (!s) {
    // the project's team: the conversation's owner, or – while they work in another session – the first free
    // member, who covers for them (other AIs' processes aren't conversations: just the first free member)
    const projectKey = sessionKey(ev);
    const project = basename(projectRoot(ev.cwd)) || ev.source;
    const busy = new Set([...sessions.values()].map((x) => x.key));
    const conversation = ev.sessionId.startsWith('proc:') ? null : ev.sessionId;
    const { key, slot, owner, substitute } = store.assignMember(projectKey, conversation, busy);
    const { name } = store.profile(key, project, { project: projectKey, slot });
    s = {
      id: ev.sessionId, key, name, coverFor: substitute ? store.nameTag(owner.key) : null,
      source: ev.source, cwd: ev.cwd, project, tty: null, mode: null,
      status: 'idle', tool: '', text: '', subagents: 0, waiting: false, lastTs: ev.ts,
      // a session we saw start costs $0 so far; for sessions already running we only count increments
      workStart: null, context: null, cost: ev.type === 'join' ? 0 : null,
    };
    sessions.set(ev.sessionId, s);
  }
  s.lastTs = ev.ts;
  if (ev.tty) s.tty = ev.tty;
  if (ev.mode) s.mode = ev.mode;

  let promoted = null;
  let workMs = 0;
  const stopClock = () => {
    workMs = s.workStart ? ev.ts - s.workStart : 0;
    s.workStart = null;
  };
  switch (ev.type) {
    case 'prompt': case 'tool': case 'toolDone': case 'error':
      s.status = 'working';
      s.waiting = false;
      s.workStart ??= ev.ts;
      if (ev.tool) s.tool = ev.tool;
      if (ev.text) s.text = ev.text;
      if (ev.type === 'tool' && ev.tool !== 'Proc') promoted = store.recordTool(s.key, toolCategory(ev.tool));
      break;
    case 'subStart':
      s.subagents += 1;
      s.status = 'working';
      s.waiting = false;
      s.workStart ??= ev.ts;
      promoted = store.recordTool(s.key, 'agents');
      break;
    case 'subStop': s.subagents = Math.max(0, s.subagents - 1); break;
    case 'waiting': s.waiting = true; break;
    case 'done':
      stopClock();
      promoted = store.recordDone(s.key, workMs);
      s.status = 'idle';
      s.waiting = false;
      break;
    case 'failure': case 'idle':
      stopClock();
      store.recordWork(s.key, workMs);
      s.status = 'idle';
      s.waiting = false;
      break;
    default: break;
  }
  return { s, promoted, workMs };
}

function ingest(ev) {
  const result = applyToSession(ev);
  const s = result?.s;
  if (s) {
    ev.project = s.project;
    ev.name = s.name;
    ev.profile = store.publicProfile(s.key);
    ev.coverFor = s.coverFor; // { key, name, whom } of the owner this one covers for, or null
    if (ev.type === 'done') ev.workMs = result.workMs; // long tasks tire employees out (renderer mood)
  }
  broadcast('office:event', ev);
  if (s && result.promoted != null) {
    broadcast('office:event', { type: 'levelUp', sessionId: s.id, profile: ev.profile, ts: ev.ts });
    notify(`⭐ ${s.name} povýšen(a)!`, `${s.project}: nově ${ev.profile.title}`, s.id);
  }
  if (s) notifyFor(ev, s, result.workMs);
  updateTray();
}

const fmtDuration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

function notifyFor(ev, s, workMs) {
  const who = `${s.name} (${s.project})`;
  if (ev.type === 'waiting') notify(`🙋 ${who} potřebuje povolení`, ev.text || 'Čeká na tvoje rozhodnutí.', s.id);
  else if (ev.type === 'done' && workMs >= 20_000) notify(`✅ ${who} má hotovo`, `Úkol trval ${fmtDuration(workMs)}.`, s.id);
  else if (ev.type === 'failure') {
    notify(ev.limit ? '⛔ Došly tokeny' : `⚠️ ${who}: chyba API`, ev.limit ? 'Limit předplatného vyčerpán – kancelář stávkuje.' : ev.text, s.id);
  }
}

function broadcast(channel, payload) {
  for (const win of [mainWin, popWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- notifications & focus

function notify(title, body, sessionId) {
  if (!prefs.notify || !Notification.isSupported()) return;
  if (mainWin?.isVisible() && mainWin.isFocused()) return; // the office itself is in front
  const n = new Notification({ title, body, silent: true });
  n.on('click', () => focusSession(sessionId));
  n.show();
}

async function focusSession(id) {
  // a session AI Office runs itself → its conversation panel (also from the menu-bar popover and notifications)
  if (agents?.has(id)) {
    showMainWindow();
    mainWin.webContents.send('chat:show', id);
    return { name: 'AI Office' };
  }
  const s = sessions.get(id);
  const tty = s?.tty ?? (id.startsWith('proc:') ? id.split(':')[2] : null);
  if (!tty) return null;
  return focusTty(tty);
}

// ---------------------------------------------------------------- status line (rate limits, context, cost)

/** Latest subscription usage from Claude Code's status line (account-wide, so any session will do). */
let limits = null;

function pickWindow(w) {
  const used = Number(w?.used_percentage);
  if (!Number.isFinite(used)) return null;
  return { used: Math.max(0, Math.min(100, used)), resetsAt: Number(w.resets_at) * 1000 || null };
}

function onStatus(status) {
  updateSessionStats(status);
  const rl = status?.rate_limits;
  if (!rl) return;
  const next = { fiveHour: pickWindow(rl.five_hour), week: pickWindow(rl.seven_day), ts: Date.now() };
  if (!next.fiveHour && !next.week) return;
  const changed = JSON.stringify({ ...limits, ts: 0 }) !== JSON.stringify({ ...next, ts: 0 });
  limits = next;
  if (changed) {
    broadcast('office:limits', limits);
    updateTray();
  }
}

/** Per-session context fill and cost ("salary"). */
function updateSessionStats(status) {
  const s = sessions.get(status?.session_id);
  if (!s) return;
  let changed = false;
  const ctx = Number(status.context_window?.used_percentage);
  if (Number.isFinite(ctx) && Math.round(ctx) !== s.context) {
    s.context = Math.round(ctx);
    changed = true;
  }
  const cost = Number(status.cost?.total_cost_usd);
  if (Number.isFinite(cost) && cost !== s.cost) {
    if (s.cost != null && cost > s.cost) store.recordCost(s.key, cost - s.cost);
    s.cost = cost;
    changed = true;
  }
  if (changed) broadcast('office:event', { type: 'stats', sessionId: s.id, context: s.context, cost: s.cost, ts: Date.now() });
}

// ---------------------------------------------------------------- HTTP

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method === 'GET' && req.url === '/sessions') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([...sessions.values()], null, 2));
    }
    if (req.method === 'GET' && req.url === '/limits') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(limits));
    }
    const isEvent = req.url.startsWith('/event');
    const isStatus = req.url.startsWith('/status');
    if (req.method !== 'POST' || (!isEvent && !isStatus)) {
      res.statusCode = 404;
      return res.end();
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      res.end('ok');
      try {
        const payload = JSON.parse(body);
        if (isStatus) return onStatus(payload);
        const ev = normalize(payload);
        if (ev) ingest(ev);
      } catch { /* malformed payload – ignore */ }
    });
  });
  server.on('error', (err) => console.error(`[ai-office] HTTP server: ${err.message}`));
  server.listen(PORT, '127.0.0.1');
}

// ---------------------------------------------------------------- other AI CLIs

const OTHER_AIS = [
  ['Codex', /(?:^|[\s/])codex(?:\s|$)/],
  ['Gemini', /(?:^|[\s/])gemini(?:\s|$)/],
  ['Aider', /(?:^|[\s/])aider(?:\s|$)/],
  ['OpenCode', /(?:^|[\s/])opencode(?:\s|$)/],
  ['Cursor', /(?:^|[\s/])cursor-agent(?:\s|$)/],
];
const procSeen = new Map(); // id -> { busy }

function scanProcesses() {
  execFile('ps', ['-axo', 'pid=,tty=,%cpu=,args='], { maxBuffer: 16e6 }, (err, out) => {
    if (err) return;
    const found = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.,]+)\s+(.*)$/);
      if (!m || m[2] === '??') continue; // only interactive (terminal) processes
      const [, pid, tty, cpu, args] = m;
      for (const [name, re] of OTHER_AIS) {
        if (!re.test(args)) continue;
        const id = `proc:${name}:${tty}`;
        const f = found.get(id) ?? { name, pid, cpu: 0 };
        f.cpu += Number(cpu.replace(',', '.'));
        found.set(id, f);
      }
    }
    const ts = Date.now();
    for (const [id, f] of found) {
      const busy = f.cpu > 1.5;
      if (!procSeen.has(id)) {
        procSeen.set(id, { busy: null });
        ingest({ type: 'join', sessionId: id, source: f.name, cwd: '', ts });
        resolveCwd(f.pid, id, f.name);
      }
      const seen = procSeen.get(id);
      if (seen.busy !== busy) {
        seen.busy = busy;
        ingest(busy
          ? { type: 'tool', tool: 'Proc', text: '', sessionId: id, source: f.name, ts }
          : { type: 'idle', sessionId: id, source: f.name, ts });
      } else {
        const s = sessions.get(id);
        if (s) s.lastTs = ts;
      }
    }
    for (const id of [...procSeen.keys()]) {
      if (found.has(id)) continue;
      procSeen.delete(id);
      ingest({ type: 'leave', sessionId: id, ts });
    }
  });
}

function resolveCwd(pid, id, name) {
  execFile('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], (err, out) => {
    const cwd = out?.split('\n').find((l) => l.startsWith('n'))?.slice(1);
    const s = sessions.get(id);
    if (err || !cwd || !s) return;
    s.cwd = cwd;
    s.project = `${name} · ${basename(cwd)}`;
    broadcast('office:event', { type: 'meta', sessionId: id, project: s.project, cwd });
  });
}

function sweepStale() {
  const ts = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.id.startsWith('proc:') && ts - s.lastTs > STALE_MS) ingest({ type: 'leave', sessionId: s.id, ts });
  }
}

// ---------------------------------------------------------------- history

/** One-time import of past Claude Code conversations (everything before live tracking began). */
async function importHistoryOnce() {
  if (store.data.history || process.env.AI_OFFICE_SCREENSHOT || process.env.AI_OFFICE_NO_HISTORY) return;
  const started = Date.now();
  try {
    const history = await scanHistory({ until: store.liveSince() });
    store.importHistory(history);
    const rows = Object.values(history.projects);
    const sum = (field) => rows.reduce((acc, p) => acc + p[field], 0);
    console.log(`[ai-office] history: ${history.sessions} sessions, ${rows.length} projects, ${sum('done')} tasks, ${sum('xp')} XP in ${Date.now() - started} ms`);
    notify('📚 Historie načtena', `${rows.length} zaměstnanců · ${sum('done')} hotových úkolů · ${sum('xp')} XP`, '');
  } catch (err) {
    console.error(`[ai-office] history: ${err.message}`);
  }
}

// ---------------------------------------------------------------- demo

function runDemo() {
  for (const [delay, payload] of demoScript()) {
    setTimeout(() => {
      if (payload.status) return onStatus(payload.status);
      const ev = normalize(payload);
      if (ev) ingest(ev);
    }, delay);
  }
}

// ---------------------------------------------------------------- conversations (sessions run by AI Office)

const openExternal = (url) => (/^https?:\/\//i.test(String(url)) ? shell.openExternal(String(url)) : null);

/** Project folders for a new task: the office's teams and folders of earlier conversations, most recent first. */
function projectFolders() {
  const seen = new Map();
  for (const s of agents.list()) {
    const root = projectRoot(s.cwd) || s.cwd;
    if (!seen.has(root)) seen.set(root, { path: root, label: basename(root), last: s.lastActive });
  }
  for (const p of store.projects()) {
    const known = seen.get(p.path);
    if (known) known.last = Math.max(known.last, p.last);
    else seen.set(p.path, p);
  }
  return [...seen.values()].filter((p) => fs.existsSync(p.path)).sort((a, b) => b.last - a.last);
}

/**
 * The model a session of ours answers with: its running process's, else the one of its last reply (the index reads
 * it from the transcript) – unless you picked another one since.
 */
function sessionModel(s, indexed) {
  if (s.running) return s.liveModel;
  const last = s.liveModel ?? indexed?.lastModel ?? null;
  return last && (!s.model || last.includes(s.model)) ? last : null;
}

/** A session of ours as a list entry: the index knows its title and transcript, `agents` its process and settings. */
function ourSummary(id, indexed = conversations.get(id)) {
  const s = agents.summary(id);
  if (!s) return null;
  return {
    ...indexed,
    ...s,
    liveModel: sessionModel(s, indexed),
    projectPath: indexed?.projectPath ?? (projectRoot(s.cwd) || s.cwd),
    title: conversations.titleOf(id) ?? indexed?.title ?? (s.title || 'Bez názvu'),
    lastActive: Math.max(s.lastActive ?? 0, indexed?.lastActive ?? 0),
    source: 'office',
    managed: true,
    archived: conversations.isArchived(id),
    owner: store.nameTag(store.ownerOf(id)?.key),
  };
}

/** A conversation of another app (Claude desktop, a terminal): nothing runs, nothing is set; the model of its last reply. */
const foreignSummary = (indexed) => ({
  ...indexed, managed: false, running: false, busy: false, activity: '', summary: '', mode: null, model: null, effort: null, cost: 0,
  liveModel: indexed.lastModel ?? null,
  owner: store.nameTag(store.ownerOf(indexed.id)?.key),
});

/** Every conversation – the index, sessions of ours merged in (also the ones without a transcript yet) – most recent first. */
function conversationList() {
  const out = [];
  const seen = new Set();
  for (const c of conversations.list()) {
    seen.add(c.id);
    out.push(agents.has(c.id) ? ourSummary(c.id, c) : foreignSummary(c));
  }
  for (const s of agents.list()) {
    if (!seen.has(s.id) && !conversations.isHidden(s.id)) out.push(ourSummary(s.id));
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

let listTimer = null;
/** Tells the renderer to ask for the list again – at most twice a second (the first index scan fires often). */
function listChanged() {
  listTimer ??= setTimeout(() => {
    listTimer = null;
    broadcast('chat:list', null);
  }, 500);
}

async function openConversation(id) {
  if (agents.has(id)) {
    const conv = await agents.open(id);
    return conv && { ...ourSummary(id), customTitle: conv.customTitle, items: conv.items, seq: conv.seq };
  }
  const indexed = conversations.get(id);
  const file = conversations.fileOf(id);
  if (!indexed || !file) return null;
  const conv = await agents.open(id, { file, cwd: indexed.cwd });
  return conv && { ...conv, ...foreignSummary(indexed), liveModel: conv.liveModel ?? indexed.lastModel ?? null };
}

/** A copy of a conversation as a session of ours (cut before your message no. `before`), under the original's title. */
async function forkConversation(id, before = null) {
  const own = agents.has(id);
  const indexed = conversations.get(id);
  const title = conversations.titleOf(id) ?? indexed?.title ?? agents.summary(id)?.title;
  const newId = await agents.fork({
    id, before: Number.isInteger(before) && before >= 0 ? before : null, cwd: indexed?.cwd ?? null, file: own ? null : conversations.fileOf(id),
  });
  store.inheritOwner(id, newId); // a branch or rewind belongs to the original's owner (also a reply to another app's conversation)
  // a name you gave the original stays yours: Claude's titles come along in the copied transcript and would beat `auto`
  if (conversations.titles[id]) conversations.rename(newId, conversations.titles[id]);
  else if (title) conversations.setAuto(newId, title);
  listChanged();
  return newId;
}

/** Your message; a conversation of another app is continued in a copy of ours (the original stays as it was). */
async function sendTo(id, text) {
  if (agents.has(id) || !String(text ?? '').trim()) {
    await agents.send(id, text);
    return id;
  }
  const newId = await forkConversation(id);
  await agents.send(newId, text);
  return newId;
}

/** Rewind: the copy takes the original's place in the list. */
async function rewindConversation(id, before) {
  const newId = await forkConversation(id, before);
  conversations.hide(id);
  agents.forget(id);
  return newId;
}

const MODEL_LABELS = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const EFFORT_LABELS = { low: 'nízké', medium: 'střední', high: 'vysoké', xhigh: 'velmi vysoké', max: 'maximální' };

/** Model and effort of your Claude Code settings – what a session without its own choice runs with. */
function claudeDefaults() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return { model: str(s?.model), effort: str(s?.effortLevel) };
  } catch {
    return { model: null, effort: null };
  }
}

function chatOptions() {
  const defaults = claudeDefaults();
  const fallback = (label) => (label ? `výchozí (${label})` : 'výchozí');
  return {
    models: [{ value: '', label: fallback(defaults.model && (MODEL_LABELS[defaults.model] ?? defaults.model)) }, ...MODELS.map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m }))],
    efforts: [{ value: '', label: fallback(defaults.effort && (EFFORT_LABELS[defaults.effort] ?? defaults.effort)) }, ...EFFORTS.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e }))],
    defaults,
  };
}

function setupAgents() {
  const dir = app.getPath('userData');
  agents = new Agents({ dir, port: PORT });
  conversations = new Conversations({ dir });
  const running = new Map(); // id → running, to tell the list about new sessions and ones that started or ended
  agents.on('item', (p) => broadcast('chat:item', p));
  agents.on('state', (s) => {
    broadcast('chat:state', ourSummary(s.id) ?? s);
    if (running.get(s.id) !== s.running) {
      running.set(s.id, s.running);
      listChanged();
    }
  });
  agents.on('status', onStatus); // cost and subscription limits, as if from the status line
  agents.on('title', ({ id, title }) => conversations.setAuto(id, title));
  agents.on('turn', ({ id }) => conversations.touch(id).catch(() => {})); // the transcript grew: re-index it
  conversations.on('update', listChanged);
  ipcMain.handle('chat:list', () => conversationList());
  ipcMain.handle('chat:open', (_e, id) => openConversation(String(id)));
  ipcMain.handle('chat:create', (_e, o) => agents.create({ cwd: o?.cwd, prompt: o?.prompt, model: o?.model, effort: o?.effort }));
  ipcMain.handle('chat:send', (_e, id, text) => sendTo(String(id), text));
  ipcMain.handle('chat:stop', (_e, id) => agents.stop(String(id)));
  ipcMain.handle('chat:dismiss', (_e, id) => agents.dismiss(String(id)));
  ipcMain.handle('chat:fork', (_e, id, before) => forkConversation(String(id), before));
  ipcMain.handle('chat:rewind', (_e, id, before) => rewindConversation(String(id), before));
  ipcMain.handle('chat:rename', (_e, id, title) => conversations.rename(String(id), String(title ?? '')));
  ipcMain.handle('chat:archive', (_e, id, on) => conversations.archive(String(id), Boolean(on)));
  ipcMain.handle('chat:search', (_e, q) => conversations.search(String(q ?? '')));
  ipcMain.handle('chat:setOptions', (_e, id, o) => (agents.setOptions(String(id), { model: o?.model, effort: o?.effort }) ? ourSummary(String(id)) : null));
  ipcMain.handle('chat:options', () => chatOptions());
  ipcMain.handle('chat:projects', () => projectFolders());
  ipcMain.handle('chat:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Složka projektu', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // the first scan of every transcript takes seconds: it starts once the office window is up
  app.once('browser-window-created', (_e, win) => {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      conversations.start();
    };
    win.webContents.once('did-finish-load', start);
    setTimeout(start, 5000).unref();
  });
  app.on('before-quit', () => {
    agents.shutdown();
    conversations.stop();
  });
}

// ---------------------------------------------------------------- the director's to-do list (Todoist)

function showTodos() {
  showMainWindow();
  mainWin.webContents.send('todoist:show');
}

function setupTodoist() {
  todoist = new Todoist({ dir: app.getPath('userData'), safeStorage });
  todoist.on('update', (snapshot) => broadcast('todoist:update', snapshot));
  ipcMain.handle('todoist:status', () => todoist.status());
  ipcMain.handle('todoist:list', (_e, force) => todoist.list(Boolean(force)));
  ipcMain.handle('todoist:setToken', (_e, token) => todoist.setToken(token));
  ipcMain.handle('todoist:clearToken', () => todoist.clearToken());
  ipcMain.handle('todoist:create', (_e, task) => todoist.create(task ?? {}));
  ipcMain.handle('todoist:close', (_e, id) => todoist.close(String(id)));
  ipcMain.handle('todoist:setDue', (_e, id, due) => todoist.setDue(String(id), due ? String(due) : null));
  ipcMain.handle('todoist:open', () => showTodos());
  todoist.start(); // polling – a no-op without a token (the renderer asks for the list once it is set)
  app.on('before-quit', () => todoist.stop());
}

// ---------------------------------------------------------------- windows

const webPreferences = {
  preload: PRELOAD,
  autoplayPolicy: 'no-user-gesture-required',
  // screenshot runs: keep painting while other windows cover the office, or the capture shows a stale frame
  backgroundThrottling: !process.env.AI_OFFICE_SCREENSHOT,
};

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 748, useContentSize: true, minWidth: 640, minHeight: 388,
    title: 'AI Office', backgroundColor: '#1a1c2c', show: false, webPreferences,
  });
  mainWin.loadFile(INDEX);
  // links in conversations open in the browser, the office never navigates away
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternal(url);
  });
  if (process.env.AI_OFFICE_SCREENSHOT) {
    // test runs: surface renderer errors on stdout (scripts/smoke.js fails on them)
    mainWin.webContents.on('console-message', (e, legacyLevel, legacyMessage) => {
      const level = e.level ?? legacyLevel;
      if (level === 'error' || level === 3) console.log(`[renderer error] ${e.message ?? legacyMessage}`);
    });
    mainWin.webContents.on('render-process-gone', (_e, details) => console.log(`[renderer error] crashed: ${details.reason}`));
  }
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // keep running in the menu bar
    mainWin.hide();
  });
}

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin.show();
  mainWin.focus();
}

function createPopover() {
  popWin = new BrowserWindow({
    width: 640, height: 388, useContentSize: true, show: false, frame: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#1a1c2c', webPreferences,
  });
  popWin.loadFile(INDEX, { query: { mode: 'compact' } });
  popWin.on('blur', () => popWin.hide());
}

function togglePopover() {
  if (popWin.isVisible()) return popWin.hide();
  const tb = tray.getBounds();
  const [w] = popWin.getSize();
  const { workArea } = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const x = Math.max(workArea.x + 8, Math.min(Math.round(tb.x + tb.width / 2 - w / 2), workArea.x + workArea.width - w - 8));
  popWin.setPosition(x, Math.round(tb.y + tb.height + 4));
  popWin.show();
  popWin.focus();
}

// ---------------------------------------------------------------- tray

const TRAY_ICON = [
  '................',
  '....########....',
  '....#......#....',
  '..############..',
  '..#..........#..',
  '..#.##.##.##.#..',
  '..#.##.##.##.#..',
  '..#..........#..',
  '..#.##.##.##.#..',
  '..#.##.##.##.#..',
  '..#..........#..',
  '..#....##....#..',
  '..#....##....#..',
  '..#....##....#..',
  '.##############.',
  '................',
];

function trayImage() {
  const size = 32; // 16pt @2x
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (TRAY_ICON[y >> 1][x >> 1] === '#') buf[(y * size + x) * 4 + 3] = 255; // black, opaque (BGRA)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const all = [...sessions.values()];
  const waiting = all.filter((s) => s.waiting).length;
  tray.setTitle(all.length ? ` ${all.length}${waiting ? ' ❗' : ''}` : '');
  const left = (w) => (w ? `${Math.round(100 - w.used)} %` : '–');
  const limitText = limits ? `\nZbývá: 5h ${left(limits.fiveHour)} · týden ${left(limits.week)}` : '';
  tray.setToolTip((all.length
    ? `AI Office – ${all.length} v kanceláři${waiting ? `, ${waiting} čeká na tebe` : ''}`
    : 'AI Office – kancelář je prázdná') + limitText);
}

function trayMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Otevřít kancelář', click: showMainWindow },
    { label: 'Statistiky…', click: () => { showMainWindow(); mainWin.webContents.send('office:showStats'); } },
    { label: 'Úkoly ředitele (Todoist)…', click: showTodos },
    {
      label: 'Okno vždy navrchu', type: 'checkbox', checked: Boolean(mainWin?.isAlwaysOnTop()),
      click: (item) => { showMainWindow(); mainWin.setAlwaysOnTop(item.checked, 'floating'); },
    },
    { label: 'Zvuky', type: 'checkbox', checked: prefs.sound, click: (item) => setPref('sound', item.checked) },
    { label: 'Notifikace', type: 'checkbox', checked: prefs.notify, click: (item) => setPref('notify', item.checked) },
    { label: 'Spouštět po přihlášení', type: 'checkbox', checked: login, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Přehrát demo', click: runDemo },
    { type: 'separator' },
    { label: 'Ukončit AI Office', role: 'quit' },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', togglePopover);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  updateTray();
}

// ---------------------------------------------------------------- app

// Screenshot runs get their own profile so they don't collide with a running instance.
if (process.env.AI_OFFICE_SCREENSHOT) app.setPath('userData', path.join(app.getPath('temp'), 'ai-office-screenshot'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', showMainWindow);
  app.on('window-all-closed', () => { /* stay alive in the menu bar */ });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    if (process.env.AI_OFFICE_SCREENSHOT) store.showDemo = true;
    // projects saved under a repository subfolder or worktree join their repository
    const moved = store.rekey((project) => (project.startsWith('/') ? projectRoot(project) : null));
    if (moved) console.log(`[ai-office] moved ${moved} employee(s) from repository subfolders to their repositories`);
    ipcMain.handle('office:snapshot', () => [...sessions.values()].map((s) => ({ ...s, profile: store.publicProfile(s.key) })));
    ipcMain.handle('office:info', () => ({ port: PORT, sound: prefs.sound, limits }));
    ipcMain.handle('office:focus', (_e, id) => focusSession(String(id)));
    ipcMain.handle('office:stats', () => store.stats());
    ipcMain.handle('office:openExternal', (_e, url) => openExternal(url));
    setupAgents();
    setupTodoist();
    app.on('before-quit', () => store.flush());
    loadPrefs();
    importHistoryOnce(); // takes its cutoff now, before live events can create new profiles

    startServer();
    createMainWindow();
    createPopover();
    createTray();
    scanProcesses();
    setInterval(scanProcesses, SCAN_MS);
    setInterval(sweepStale, 60_000);

    // Dev helper: AI_OFFICE_SCREENSHOT=/path.png npm start → runs the demo, saves a screenshot, quits.
    const shot = process.env.AI_OFFICE_SCREENSHOT;
    if (shot) {
      runDemo();
      // Optional JS run in the renderer mid-scenario (e.g. to force a behaviour for a screenshot).
      if (process.env.AI_OFFICE_EVAL) setTimeout(() => mainWin.webContents.executeJavaScript(process.env.AI_OFFICE_EVAL), 8000);
      setTimeout(async () => {
        const img = await mainWin.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.AI_OFFICE_SCREENSHOT_DELAY) || 11000);
    }
  });
}
