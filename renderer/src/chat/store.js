/** Conversation state in the renderer: sessions AI Office runs, their items, what's open. */
import { state } from '../state.js';

export const chat = {
  /** @type {Map<string, object>} id → summary from the main process (title, cwd, project, busy, activity, …) */
  sessions: new Map(),
  /** @type {Map<string, object[]>} id → conversation items (loaded when a conversation is opened) */
  items: new Map(),
  /** @type {Map<string, number>} id → sequence number of the last item update applied */
  seq: new Map(),
  /** @type {null | 'new' | 'switch'} open dialog */
  modal: null,
};

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
export const isManaged = (id) => chat.sessions.has(id);

export async function refreshList() {
  if (!window.office?.chat) return;
  const list = await window.office.chat.list();
  chat.sessions = new Map(list.map((s) => [s.id, s]));
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

export async function openChat(id) {
  if (!window.office?.chat) return;
  if (!chat.items.has(id)) pending.set(id, pending.get(id) ?? []);
  const conv = await window.office.chat.open(id);
  const early = pending.get(id) ?? [];
  pending.delete(id);
  if (!conv) return;
  const { items, seq, ...summary } = conv;
  chat.sessions.set(id, summary);
  if (!chat.items.has(id)) {
    chat.items.set(id, items);
    chat.seq.set(id, seq);
    for (const update of early) applyItem(update);
  }
  chat.modal = null;
  state.chatOpen = id;
  changed();
}

export function closeChat() {
  state.chatOpen = null;
  changed();
}

export function openModal(kind) {
  chat.modal = kind;
  changed();
}

export function closeModal() {
  chat.modal = null;
  changed();
}

if (window.office?.chat) {
  window.office.chat.onItem((update) => {
    if (pending.has(update.id)) pending.get(update.id).push(update);
    else applyItem(update); // conversations not opened yet are loaded in full when they are
    changed();
  });
  window.office.chat.onState((summary) => {
    chat.sessions.set(summary.id, summary);
    changed();
  });
  window.office.chat.onShow((id) => openChat(id));
}
