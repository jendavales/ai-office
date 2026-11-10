/** The director's to-do list in the renderer: what Todoist sent, the chosen deadline filter, what's open. */
import { ipcError } from '../chat/lib.js';
import { changed, chat } from '../chat/store.js';
import { DIRECTOR_LINES } from '../content/texts.js';
import { randItem } from '../core/util.js';
import { director, setDirectorTodos } from '../entities/director.js';
import { state } from '../state.js';
import { dayKey, summarize } from './model.js';

export const todo = {
  status: null,      // { configured, tokenPage, syncedAt, error, encrypted } – null until the main process answered
  tasks: [],
  projects: [],
  filter: 'today',   // 'today' | 'week' | 'all' | 'none' | { until: 'YYYY-MM-DD' }
  settings: false,   // token form shown although a token is set
  loading: false,
  error: null,       // the last failed action (a failed sync lives in status.error)
  busy: new Set(),   // task ids with a request in flight
};

/** A snapshot from the main process (an answer or a broadcast after a sync). */
export function applyTodos(snapshot) {
  if (!snapshot) return;
  const { tasks, projects, ...status } = snapshot;
  todo.status = status;
  todo.tasks = tasks ?? [];
  todo.projects = projects ?? [];
  setDirectorTodos({ configured: status.configured, error: status.error, ...summarize(todo.tasks, dayKey()) });
  changed();
}

export async function refreshTodos(force = false) {
  if (!window.office?.todoist) return;
  todo.loading = true;
  changed();
  try {
    applyTodos(await window.office.todoist.list(force));
  } catch (err) {
    todo.error = ipcError(err);
  }
  todo.loading = false;
  changed();
}

export function openTodos() {
  if (!window.office?.todoist) return;
  state.chatOpen = null;
  chat.modal = null;
  state.todosOpen = true;
  changed();
  refreshTodos();
}

export function closeTodos() {
  state.todosOpen = false;
  todo.settings = false;
  changed();
}

export function setFilter(filter) {
  todo.filter = filter;
  changed();
}

export function showSettings(on) {
  todo.settings = on;
  todo.error = null;
  changed();
}

/** Runs a request against the main process; its answer is the new snapshot. Resolves with success. */
async function action(fn, id = null) {
  if (id) todo.busy.add(id);
  todo.error = null;
  changed();
  try {
    applyTodos(await fn());
    return true;
  } catch (err) {
    todo.error = ipcError(err);
    return false;
  } finally {
    if (id) todo.busy.delete(id);
    changed();
  }
}

export async function saveToken(token) {
  const ok = await action(() => window.office.todoist.setToken(token));
  if (ok) todo.settings = false;
  changed();
  return ok;
}

export const forgetToken = () => action(() => window.office.todoist.clearToken());

export async function addTodo(task) {
  const ok = await action(() => window.office.todoist.create(task));
  if (ok) director.say(randItem(DIRECTOR_LINES.added), 2.5);
  return ok;
}

export async function doneTodo(id) {
  const ok = await action(() => window.office.todoist.close(id), id);
  if (ok) director.say(randItem(DIRECTOR_LINES.done), 2.5, 'ok');
  return ok;
}

export const setTodoDue = (id, due) => action(() => window.office.todoist.setDue(id, due), id);

if (window.office?.todoist) {
  window.office.todoist.onUpdate(applyTodos);
  window.office.todoist.onShow(openTodos);
  refreshTodos(); // the director needs the counts even while the panel is closed
}
