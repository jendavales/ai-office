/**
 * Conversation state in the renderer: every Claude conversation on this machine (the ones AI Office runs and the
 * ones from Claude desktop or a terminal), the items of the opened ones, drafts, search, what's open.
 */
import { state } from '../state.js';
import { ipcError } from './lib.js';

const PANEL_KEY = 'ai-office:panel';
const DRAFTS_KEY = 'ai-office:drafts';

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

export const chat = {
  /** @type {Map<string, object>} id → summary from the main process (title, cwd, project, source, managed, busy, …) */
  sessions: new Map(),
  /** list() answered at least once (the first scan of ~/.claude takes a moment) */
  listed: false,
  /** @type {Map<string, object[]>} id → conversation items (loaded when a conversation is opened) */
  items: new Map(),
  /** @type {Map<string, number>} id → sequence number of the last item update applied */
  seq: new Map(),
  /** @type {null | { kind: 'new', busy?: boolean } | { kind: 'rewind', id: string, index: number, text: string, busy?: boolean }} open dialog */
  modal: null,
  /** @type {Map<string, string>} unsent text per conversation ('new' = the new-task dialog), kept in localStorage */
  drafts: new Map(),
  /** @type {Map<string, {model?: string, effort?: string}>} model/effort picked in a conversation from elsewhere – for its office copy */
  picked: new Map(),
  /** @type {null | {models: {value: string, label: string}[], efforts: {value: string, label: string}[], defaults: {model?: string, effort?: string}}} */
  options: null,
  query: '',           // the list's search field
  /** @type {null | Map<string, string>} id → snippet found by search(query); null = not searching */
  hits: null,
  archived: false,     // the list shows the archive instead
  focusSearch: 0,      // bumped by ⌘K – the list focuses its search field
  error: null,         // the last failed action, shown in the panel
};

state.panelOpen = load(PANEL_KEY) !== '0';
try {
  for (const [id, text] of Object.entries(JSON.parse(load(DRAFTS_KEY) ?? '{}'))) if (typeof text === 'string' && text) chat.drafts.set(id, text);
} catch { /* broken – start without drafts */ }

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

let queued = false;

function flush() {
  if (!queued) return;
  queued = false;
  for (const fn of subscribers) fn();
}

/**
 * Re-render on the next frame (streamed replies change many times a second). The timer is a fallback:
 * macOS pauses animation frames of a window that is hidden behind others.
 */
export function changed() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
  setTimeout(flush, 100);
}

/** Is this office employee a session AI Office runs (click = conversation, not terminal)? */
export function isManaged(id) {
  const s = chat.sessions.get(id);
  return Boolean(s) && s.managed !== false;
}

/** A failed IPC call → a notice in the panel. */
function fail(err) {
  chat.error = ipcError(err);
  changed();
}

export function clearError() {
  chat.error = null;
  changed();
}

let listCalls = 0;

export async function refreshList() {
  if (!window.office?.chat) return;
  const call = ++listCalls;
  let list;
  try {
    list = await window.office.chat.list();
  } catch (err) {
    fail(err);
    return;
  }
  if (call !== listCalls) return; // a newer answer is on its way
  const next = new Map(list.map((s) => [s.id, s]));
  // the open conversation stays even when it left the list (rewound, hidden)
  const open = state.chatOpen && chat.sessions.get(state.chatOpen);
  if (open && !next.has(open.id)) next.set(open.id, open);
  chat.sessions = next;
  chat.listed = true;
  changed();
}

let listTimer = null;

/** The main process says the list changed – usually several times in a row. */
function refreshSoon() {
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 300);
}

export async function loadOptions() {
  try {
    chat.options = await window.office.chat.options();
  } catch { /* the selects stay hidden */ }
  changed();
}

// ---- drafts

let draftTimer = null;

function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = null;
  save(DRAFTS_KEY, JSON.stringify(Object.fromEntries(chat.drafts)));
}

/** Unsent text of a conversation ('new' = the new-task dialog); '' forgets it. Saved a moment later. */
export function setDraft(id, text) {
  if (String(text ?? '').trim()) chat.drafts.set(id, text);
  else chat.drafts.delete(id);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDrafts, 400);
}

window.addEventListener('beforeunload', () => { if (draftTimer) saveDrafts(); });

// ---- the panel: a conversation, or the list

function setPanel(on) {
  state.panelOpen = on;
  save(PANEL_KEY, on ? '1' : '0');
}

/** The conversation list in the panel (closes an open conversation; the caller closes the to-do list). */
export function showList({ focus = false } = {}) {
  state.chatOpen = null;
  state.todosOpen = false;
  setPanel(true);
  if (focus) chat.focusSearch += 1;
  refreshList();
  changed();
}

/** Hides the panel: the office gets the whole window. */
export function hidePanel() {
  state.chatOpen = null;
  setPanel(false);
  changed();
}

let searchTimer = null;
let searchCalls = 0;

/** The list's search field: titles and projects filter at once, search() in the prompts a moment later. */
export function setQuery(q) {
  chat.query = q;
  clearTimeout(searchTimer);
  searchCalls += 1;
  if (!q.trim()) chat.hits = null;
  else searchTimer = setTimeout(() => search(q.trim()), 200);
  changed();
}

async function search(q) {
  const call = ++searchCalls;
  try {
    const hits = await window.office.chat.search(q);
    if (call !== searchCalls) return;
    chat.hits = new Map((hits ?? []).map((h) => [h.id, h.snippet ?? '']));
    changed();
  } catch (err) {
    if (call === searchCalls) fail(err);
  }
}

export function showArchive(on) {
  chat.archived = on;
  changed();
}

/** Item updates that arrive while a conversation is being loaded (IPC replies and events aren't ordered). */
const pending = new Map();

function applyItem({ id, index, item, seq }) {
  const items = chat.items.get(id);
  if (!items || seq <= (chat.seq.get(id) ?? 0)) return; // already part of what open() returned
  items[index] = item;
  chat.seq.set(id, seq);
}

let opening = 0;

export async function openChat(id) {
  if (!window.office?.chat || typeof id !== 'string' || !id) return;
  const ticket = ++opening;
  // conversations from elsewhere get no live updates: read again each time (you may have gone on in the terminal)
  const fresh = !chat.items.has(id) || chat.sessions.get(id)?.managed === false;
  if (fresh) pending.set(id, pending.get(id) ?? []);
  let conv;
  try {
    conv = await window.office.chat.open(id);
  } catch (err) {
    pending.delete(id);
    fail(err);
    return;
  }
  const early = pending.get(id) ?? [];
  pending.delete(id);
  if (!conv) {
    if (ticket === opening) fail('Konverzace už neexistuje.');
    return;
  }
  const { items, seq, ...summary } = conv;
  chat.sessions.set(id, { ...chat.sessions.get(id), ...summary });
  if (fresh) {
    chat.items.set(id, items);
    chat.seq.set(id, seq);
    for (const update of early) applyItem(update);
  }
  if (ticket !== opening) return; // you opened another one meanwhile
  chat.modal = null;
  chat.error = null;
  state.chatOpen = id;
  state.todosOpen = false;
  changed();
}

/** Back from a conversation to the list. */
export function closeChat() {
  state.chatOpen = null;
  setPanel(true);
  changed();
}

export function openModal(kind, data = {}) {
  if (chat.modal?.busy) return;
  chat.modal = { ...data, kind };
  chat.error = null;
  changed();
}

/** Closes the dialog – not while it waits for the main process (creating a task, rewinding). */
export function closeModal() {
  if (chat.modal?.busy) return;
  chat.modal = null;
  changed();
}

export function lockModal(busy) {
  if (chat.modal) chat.modal.busy = busy;
  changed();
}

// ---- actions (failures end up in chat.error)

/** Your message; a conversation from elsewhere gets an office copy, which opens instead. Resolves with success. */
export async function sendMessage(id, text) {
  chat.error = null;
  const picked = chat.picked.get(id);
  try {
    let target;
    if (picked && Object.values(picked).some(Boolean)) {
      // model/effort picked in a conversation from elsewhere: copy it first so the copy answers with them right away
      const copy = await window.office.chat.fork(id, null);
      await window.office.chat.setOptions(copy, picked);
      target = (await window.office.chat.send(copy, text)) || copy;
    } else {
      target = await window.office.chat.send(id, text);
    }
    if (typeof target === 'string' && target && target !== id) {
      chat.picked.delete(id);
      await refreshList();
      await openChat(target);
    }
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Model and/or effort of a conversation ('' = Claude Code's default); from elsewhere: remembered for its copy (sendMessage). */
export async function setChatOptions(id, change) {
  const s = chat.sessions.get(id);
  if (!s) return;
  if (s.managed === false) chat.picked.set(id, { ...chat.picked.get(id), ...change });
  else chat.sessions.set(id, { ...s, ...change });
  changed();
  try {
    const next = await window.office.chat.setOptions(id, change);
    if (next) chat.sessions.set(id, { ...chat.sessions.get(id), ...next });
  } catch (err) {
    fail(err);
  }
  changed();
}

/** '' = back to the automatic title. */
export async function renameChat(id, title) {
  const s = chat.sessions.get(id);
  if (s && title) chat.sessions.set(id, { ...s, title });
  changed();
  try {
    await window.office.chat.rename(id, title);
    await refreshList(); // the automatic title comes back from the main process
  } catch (err) {
    fail(err);
  }
}

export async function archiveChat(id, on) {
  const s = chat.sessions.get(id);
  if (s) chat.sessions.set(id, { ...s, archived: on });
  changed();
  try {
    await window.office.chat.archive(id, on);
  } catch (err) {
    fail(err);
  }
  await refreshList();
}

/** A copy of the conversation up to (not including) your message with ordinal `before`; it opens. */
export async function forkChat(id, before) {
  try {
    const copy = await window.office.chat.fork(id, before);
    await refreshList();
    await openChat(copy);
  } catch (err) {
    fail(err);
  }
}

/** Back to before your message with ordinal `before`: a copy replaces the conversation, the message waits in its composer. */
export async function rewindChat(id, before, text) {
  try {
    const copy = await window.office.chat.rewind(id, before);
    if (text) setDraft(copy, text);
    if (chat.modal) chat.modal.busy = false;
    await refreshList();
    await openChat(copy);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

if (window.office?.chat) {
  window.office.chat.onItem((update) => {
    if (pending.has(update.id)) pending.get(update.id).push(update);
    else applyItem(update); // conversations not opened yet are loaded in full when they are
    changed();
  });
  window.office.chat.onState((summary) => {
    chat.sessions.set(summary.id, { ...chat.sessions.get(summary.id), ...summary });
    changed();
  });
  window.office.chat.onShow((id) => openChat(id));
  window.office.chat.onList?.(refreshSoon);
}
