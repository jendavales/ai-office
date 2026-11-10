'use strict';
/**
 * Todoist – the director's to-do list. Talks to the Todoist API v1 (the one that replaced REST v2 and
 * Sync v9): the token is your personal API token from Todoist → Settings → Integrations → Developer,
 * kept encrypted with the system keychain (Electron safeStorage) in userData/todoist.json.
 *
 * What the office needs: the active tasks with their due dates (grouped and filtered in the renderer),
 * a new task (with priority, project, labels, description and time – the renderer parses the quick-add
 * shortcuts), a changed due date, a task done. Polls every minute while a token is set.
 *
 * Events: 'update' snapshot – { configured, tokenPage, syncedAt, error, encrypted, tasks, projects }
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.todoist.com/api/v1';
const TOKEN_PAGE = 'https://app.todoist.com/app/settings/integrations/developer';
const PAGE = 200;
const POLL_MS = 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Calendar day and time of a Todoist date: '2026-11-10' (day), '2026-11-10T14:00:00' (floating time) or
 * '2026-11-10T13:00:00Z' (a fixed time zone, given in UTC – shown in local time).
 */
function dueParts(iso) {
  if (!iso) return { day: null, time: null };
  const s = String(iso);
  if (s.length <= 10) return { day: s, time: null };
  if (!s.endsWith('Z')) return { day: s.slice(0, 10), time: s.slice(11, 16) };
  const d = new Date(s);
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

const dayOf = (iso) => dueParts(iso).day;

/** Czech message for a failed API call. */
function apiError(status, body) {
  if (status === 401 || status === 403) return 'Todoist token neplatí – zkontroluj ho v nastavení.';
  if (status === 404) return 'Todoist: úkol už neexistuje.';
  if (status === 429) return 'Todoist: příliš mnoho požadavků, zkus to za chvíli.';
  let detail = '';
  try {
    detail = JSON.parse(body)?.error ?? '';
  } catch {
    detail = String(body ?? '').slice(0, 120);
  }
  return `Todoist: chyba ${status}${detail ? ` – ${detail}` : ''}`;
}

/** The part of a Todoist task the office shows. */
function publicTask(t, project = '') {
  const due = dueParts(t.due?.date);
  return {
    id: String(t.id),
    content: String(t.content ?? ''),
    description: String(t.description ?? ''),
    due: due.day,                                       // calendar day of the due date
    time: due.time,
    recurring: Boolean(t.due?.is_recurring),
    deadline: dayOf(t.deadline?.date),                  // Todoist's separate "deadline" field, if used
    priority: Number(t.priority) || 1,                  // 4 = p1 (highest) … 1 = none
    projectId: t.project_id != null ? String(t.project_id) : null,
    project: project ?? '',
    order: Number(t.child_order ?? t.order) || 0,
    url: `https://app.todoist.com/app/task/${t.id}`,
  };
}

const publicProject = (p) => ({
  id: String(p.id), name: String(p.name ?? ''), inbox: Boolean(p.is_inbox_project), order: Number(p.child_order ?? p.order) || 0,
});

class Todoist extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir userData folder (todoist.json lives there)
   * @param {Function} [o.fetch] global fetch unless a test passes its own
   * @param {object} [o.safeStorage] Electron safeStorage; without it the token is stored as plain text
   */
  constructor({ dir, fetch = globalThis.fetch, safeStorage = null, pollMs = POLL_MS, now = Date.now } = {}) {
    super();
    this.file = path.join(dir, 'todoist.json');
    this.fetchFn = fetch;
    this.safe = safeStorage;
    this.pollMs = pollMs;
    this.now = now;
    this.timer = null;
    this.syncing = null;
    this.token = null;
    this.tasks = [];
    this.projects = [];
    this.syncedAt = 0;
    this.error = null;
    this.loadToken();
  }

  // ---- token

  loadToken() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return; // no token yet
    }
    try {
      this.token = saved.encrypted ? this.safe.decryptString(Buffer.from(saved.encrypted, 'base64')) : saved.token ?? null;
    } catch {
      this.error = 'Uložený token se nepodařilo dešifrovat – zadej ho znovu.';
    }
  }

  get encrypts() {
    return Boolean(this.safe?.isEncryptionAvailable?.());
  }

  saveToken(token) {
    if (!token) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    const body = this.encrypts ? { encrypted: this.safe.encryptString(token).toString('base64') } : { token };
    fs.writeFileSync(this.file, JSON.stringify(body), { mode: 0o600 });
  }

  get configured() {
    return Boolean(this.token);
  }

  status() {
    return { configured: this.configured, tokenPage: TOKEN_PAGE, syncedAt: this.syncedAt, error: this.error, encrypted: this.encrypts };
  }

  snapshot() {
    return { ...this.status(), tasks: this.tasks, projects: this.projects };
  }

  /** Checks the token against the API first – a wrong one is never saved. */
  async setToken(raw) {
    const token = String(raw ?? '').trim();
    if (!token) throw new Error('Zadej API token.');
    await this.api('GET', '/projects?limit=1', null, token);
    this.token = token;
    this.error = null;
    this.saveToken(token);
    await this.sync();
    this.start();
    return this.snapshot();
  }

  clearToken() {
    this.stop();
    this.token = null;
    this.tasks = [];
    this.projects = [];
    this.syncedAt = 0;
    this.error = null;
    this.saveToken(null);
    this.emit('update', this.snapshot());
    return this.snapshot();
  }

  // ---- polling

  start() {
    if (!this.configured || this.timer) return;
    this.timer = setInterval(() => { this.sync(); }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---- API

  async api(method, route, body = null, token = this.token) {
    if (!token) throw new Error('Todoist není napojený – zadej API token.');
    let res;
    try {
      res = await this.fetchFn(`${API}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Todoist není dostupný (${err.message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(apiError(res.status, text));
    return text ? JSON.parse(text) : null;
  }

  /** All pages of a list endpoint (cursor pagination). */
  async pages(route) {
    const all = [];
    let cursor = null;
    do {
      const page = await this.api('GET', `${route}?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      all.push(...(Array.isArray(page) ? page : page?.results ?? []));
      cursor = (!Array.isArray(page) && page?.next_cursor) || null;
    } while (cursor);
    return all;
  }

  /** Reload projects and active tasks. Never rejects – a failure lands in `error`, the last good list stays. */
  async sync() {
    if (!this.configured) return this.snapshot();
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const [projects, tasks] = await Promise.all([this.pages('/projects'), this.pages('/tasks')]);
        const names = new Map(projects.map((p) => [String(p.id), String(p.name ?? '')]));
        this.projects = projects.map(publicProject)
          .sort((a, b) => Number(b.inbox) - Number(a.inbox) || a.order - b.order || a.name.localeCompare(b.name, 'cs'));
        this.tasks = tasks.filter((t) => !t.checked && !t.is_deleted).map((t) => publicTask(t, names.get(String(t.project_id))));
        this.syncedAt = this.now();
        this.error = null;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.syncing = null;
      }
      this.emit('update', this.snapshot());
      return this.snapshot();
    })();
    return this.syncing;
  }

  async list(force = false) {
    if (this.configured && (force || !this.syncedAt)) await this.sync();
    return this.snapshot();
  }

  // ---- writes

  /**
   * A new task. `due` is a YYYY-MM-DD day, `time` an HH:MM clock time on that day (local time – sent to
   * Todoist in UTC), `priority` Todoist's 4 = p1 … 1 = none, `labels` label names (new ones get created).
   */
  async create({ content, due = null, time = null, projectId = null, priority = null, labels = [], description = '' } = {}) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('Napiš, co je potřeba udělat.');
    if (due && !DAY.test(due)) throw new Error('Neplatné datum.');
    if (time && (!CLOCK.test(time) || !due)) throw new Error('Neplatný čas.');
    // the format alone lets 2026-13-45 or 25:99 through (and toISOString() would throw); 2026-02-31 rolls into March
    if (due && new Date(`${due}T00:00:00Z`).getUTCDate() !== Number(due.slice(8))) throw new Error('Neplatné datum.');
    const at = time ? new Date(`${due}T${time}:00`) : null;
    if (at && Number.isNaN(at.getTime())) throw new Error('Neplatný čas.');
    if (priority != null && ![1, 2, 3, 4].includes(Number(priority))) throw new Error('Neplatná priorita.');
    const names = [...new Set((Array.isArray(labels) ? labels : []).map((l) => String(l ?? '').trim()).filter(Boolean))];
    const note = String(description ?? '').trim();
    const body = {
      content: text,
      ...(at ? { due_datetime: at.toISOString() } : due ? { due_date: due } : {}),
      ...(projectId ? { project_id: String(projectId) } : {}),
      ...(priority != null && Number(priority) !== 1 ? { priority: Number(priority) } : {}),
      ...(names.length ? { labels: names } : {}),
      ...(note ? { description: note } : {}),
    };
    const t = await this.api('POST', '/tasks', body);
    if (t?.id) {
      // shows up right away; the next sync settles the details
      this.tasks = [...this.tasks, publicTask(t, this.projects.find((p) => p.id === String(t.project_id))?.name)];
      this.emit('update', this.snapshot());
    }
    this.sync();
    return this.snapshot();
  }

  async close(id) {
    await this.api('POST', `/tasks/${encodeURIComponent(id)}/close`);
    this.tasks = this.tasks.filter((t) => t.id !== String(id));
    this.emit('update', this.snapshot());
    this.sync(); // a recurring task comes back with its next date
    return this.snapshot();
  }

  /** Due date as YYYY-MM-DD, or null to remove it. */
  async setDue(id, due) {
    if (due && !DAY.test(due)) throw new Error('Neplatné datum.');
    const t = await this.api('POST', `/tasks/${encodeURIComponent(id)}`, due ? { due_date: due } : { due_string: 'no date' });
    this.tasks = this.tasks.map((x) => (x.id === String(id) ? (t?.id ? publicTask(t, x.project) : { ...x, due, time: null }) : x));
    this.emit('update', this.snapshot());
    return this.snapshot();
  }
}

module.exports = { Todoist, apiError, publicTask, TOKEN_PAGE };
