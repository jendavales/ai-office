'use strict';
process.env.TZ = 'Europe/Prague'; // times with a fixed zone come from Todoist in UTC and are shown in local time
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Todoist, apiError, publicTask } = require('../src/todoist');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-todoist-'));

/** Stand-in for Electron's safeStorage: reversible, but visibly not the plain token. */
const vault = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
};

const json = (status, body) => ({ ok: status < 400, status, text: async () => (body == null ? '' : JSON.stringify(body)) });

/**
 * Fake Todoist API: a few projects and tasks, pagination on /tasks, writes recorded in `calls`.
 * Every request must carry the right token.
 */
function fakeApi({ token = 'secret', pages = 1 } = {}) {
  const calls = [];
  const projects = [{ id: 'p1', name: 'Inbox', is_inbox_project: true, child_order: 0 }, { id: 'p2', name: 'Kancelář', child_order: 1 }];
  let tasks = [
    { id: 't1', content: 'Zavolat účetní', project_id: 'p2', priority: 4, due: { date: '2026-11-09', is_recurring: false }, child_order: 1 },
    { id: 't2', content: 'Sejít se s týmem', project_id: 'p1', priority: 1, due: { date: '2026-11-10T14:00:00', is_recurring: true }, deadline: { date: '2026-11-12' }, child_order: 2 },
    { id: 't3', content: 'Bez termínu', project_id: 'p1', priority: 2, due: null, child_order: 3 },
    { id: 'done', content: 'Hotovo', project_id: 'p1', priority: 1, checked: true, child_order: 4 },
  ];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null });
    if (init.headers.Authorization !== `Bearer ${token}`) return json(401, { error: 'Unauthorized' });
    if (init.method === 'GET' && u.pathname === '/api/v1/projects') return json(200, { results: projects, next_cursor: null });
    if (init.method === 'GET' && u.pathname === '/api/v1/tasks') {
      const cursor = Number(u.searchParams.get('cursor') ?? 0);
      const per = Math.ceil(tasks.length / pages);
      const slice = tasks.slice(cursor * per, (cursor + 1) * per);
      return json(200, { results: slice, next_cursor: cursor + 1 < pages ? String(cursor + 1) : null });
    }
    if (init.method === 'POST' && u.pathname === '/api/v1/tasks') {
      const body = JSON.parse(init.body);
      const t = { id: 'new', project_id: 'p1', priority: 1, due: body.due_datetime ? { date: body.due_datetime.replace('.000Z', 'Z') } : body.due_date ? { date: body.due_date } : null, ...body };
      tasks = [...tasks, t];
      return json(200, t);
    }
    const close = u.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/close$/);
    if (init.method === 'POST' && close) {
      tasks = tasks.filter((t) => t.id !== close[1]);
      return json(204, null);
    }
    const update = u.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (init.method === 'POST' && update) {
      const t = tasks.find((x) => x.id === update[1]);
      if (!t) return json(404, { error: 'Task not found' });
      const body = JSON.parse(init.body);
      t.due = body.due_date ? { date: body.due_date } : body.due_string === 'no date' ? null : t.due;
      return json(200, t);
    }
    return json(404, { error: 'Not found' });
  };
  return { fetch, calls, tasks: () => tasks };
}

test('API errors and task mapping', () => {
  assert.match(apiError(401, ''), /token neplatí/);
  assert.match(apiError(429, ''), /příliš mnoho/);
  assert.equal(apiError(500, JSON.stringify({ error: 'boom' })), 'Todoist: chyba 500 – boom');
  assert.equal(apiError(502, '<html>bad gateway</html>'), 'Todoist: chyba 502 – <html>bad gateway</html>');
  const t = publicTask({ id: 42, content: 'X', priority: 3, due: { date: '2026-11-10T14:00:00', is_recurring: true }, deadline: { date: '2026-11-12' }, project_id: 7, child_order: 2 }, 'Proj');
  assert.deepEqual(t, {
    id: '42', content: 'X', description: '', due: '2026-11-10', time: '14:00', recurring: true, deadline: '2026-11-12',
    priority: 3, projectId: '7', project: 'Proj', order: 2, url: 'https://app.todoist.com/app/task/42',
  });
  assert.equal(publicTask({ id: 1 }).due, null);
  // a fixed time zone: Todoist gives UTC, the office shows local time (CET in November)
  const fixed = publicTask({ id: 2, due: { date: '2026-11-10T23:30:00Z' } });
  assert.deepEqual([fixed.due, fixed.time], ['2026-11-11', '00:30']);
});

test('without a token nothing is fetched and the status says so', async () => {
  const api = fakeApi();
  const td = new Todoist({ dir: tmp(), fetch: api.fetch, safeStorage: vault });
  assert.equal(td.configured, false);
  const snap = await td.list();
  assert.equal(snap.configured, false);
  assert.deepEqual(snap.tasks, []);
  assert.equal(api.calls.length, 0);
  td.start();
  assert.equal(td.timer, null);
  await assert.rejects(td.create({ content: 'x' }), /není napojený/);
});

test('a wrong token is rejected and never saved; a right one is checked, encrypted and loaded on restart', async () => {
  const dir = tmp();
  const api = fakeApi();
  const td = new Todoist({ dir, fetch: api.fetch, safeStorage: vault, now: () => 1000 });
  await assert.rejects(td.setToken('wrong'), /token neplatí/);
  assert.equal(fs.existsSync(path.join(dir, 'todoist.json')), false);
  await assert.rejects(td.setToken('   '), /Zadej/);

  const updates = [];
  td.on('update', (s) => updates.push(s));
  const snap = await td.setToken(' secret ');
  assert.equal(snap.configured, true);
  assert.equal(snap.syncedAt, 1000);
  assert.equal(snap.error, null);
  assert.equal(updates.length, 1);
  assert.ok(td.timer, 'polling starts');
  td.stop();

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'todoist.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['encrypted']);
  assert.equal(Buffer.from(saved.encrypted, 'base64').toString(), 'enc:secret');

  const again = new Todoist({ dir, fetch: api.fetch, safeStorage: vault });
  assert.equal(again.configured, true);
  assert.equal(again.status().encrypted, true);
  // a token saved by another machine/keychain: not usable, say so, ask again
  const broken = new Todoist({ dir, fetch: api.fetch, safeStorage: { ...vault, decryptString: () => { throw new Error('nope'); } } });
  assert.equal(broken.configured, false);
  assert.match(broken.status().error, /dešifrovat/);
});

test('the list: all pages, finished tasks left out, project names, Inbox first', async () => {
  const api = fakeApi({ pages: 2 });
  const td = new Todoist({ dir: tmp(), fetch: api.fetch, safeStorage: null });
  td.token = 'secret';
  const snap = await td.list();
  assert.equal(snap.error, null);
  assert.deepEqual(snap.tasks.map((t) => t.id), ['t1', 't2', 't3']);
  assert.deepEqual(snap.tasks.map((t) => t.project), ['Kancelář', 'Inbox', 'Inbox']);
  assert.deepEqual(snap.projects.map((p) => p.name), ['Inbox', 'Kancelář']);
  assert.equal(api.calls.filter((c) => c.path.startsWith('/api/v1/tasks')).length, 2, 'two pages');
  assert.ok(api.calls.some((c) => c.path.includes('cursor=1')));
  const before = api.calls.length;
  await td.list(); // cached
  assert.equal(api.calls.length, before);
  await td.list(true); // forced
  assert.ok(api.calls.length > before);
});

test('a failed sync keeps the last good list and reports the error', async () => {
  const api = fakeApi();
  const td = new Todoist({ dir: tmp(), fetch: api.fetch });
  td.token = 'secret';
  await td.list();
  td.fetchFn = async () => { throw new TypeError('fetch failed'); };
  const snap = await td.sync();
  assert.match(snap.error, /není dostupný/);
  assert.equal(snap.tasks.length, 3);
  assert.equal(snap.configured, true);
});

test('writes: a new task with a deadline, a changed or removed deadline, a task done', async () => {
  const api = fakeApi();
  const td = new Todoist({ dir: tmp(), fetch: api.fetch });
  td.token = 'secret';
  await td.list();

  await assert.rejects(td.create({ content: '  ' }), /Napiš/);
  await assert.rejects(td.create({ content: 'x', due: '10.11.2026' }), /Neplatné datum/);
  let snap = await td.create({ content: 'Objednat papír', due: '2026-11-11', projectId: 'p2' });
  const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks');
  assert.deepEqual(post.body, { content: 'Objednat papír', due_date: '2026-11-11', project_id: 'p2' });
  assert.ok(snap.tasks.some((t) => t.id === 'new' && t.due === '2026-11-11'), 'shows up right away');
  await td.syncing; // the background reload after a write

  // the quick-add shortcuts' fields: time (local → UTC), priority, labels (trimmed, no duplicates), description
  snap = await td.create({ content: 'Zubař', due: '2026-11-11', time: '14:30', projectId: 'p2', priority: 4, labels: ['doma', ' doma ', '', null], description: ' strana 42 ' });
  const full = api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/tasks').at(-1);
  assert.deepEqual(full.body, { content: 'Zubař', due_datetime: '2026-11-11T13:30:00.000Z', project_id: 'p2', priority: 4, labels: ['doma'], description: 'strana 42' });
  const shown = snap.tasks.find((t) => t.content === 'Zubař');
  assert.deepEqual([shown.due, shown.time, shown.priority, shown.project], ['2026-11-11', '14:30', 4, 'Kancelář']);
  await td.syncing;
  await td.create({ content: 'Nic navíc', priority: 1, labels: [], description: '' });
  const posts = () => api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/tasks');
  assert.deepEqual(posts().at(-1).body, { content: 'Nic navíc' }, 'nothing is sent for the defaults');
  await td.syncing;
  await assert.rejects(td.create({ content: 'x', priority: 7 }), /Neplatná priorita/);
  await assert.rejects(td.create({ content: 'x', time: '14:00' }), /Neplatný čas/);
  await assert.rejects(td.create({ content: 'x', due: '2026-11-11', time: '9:00' }), /Neplatný čas/);
  // the right format but out of range: a clear message, not toISOString()'s RangeError
  await assert.rejects(td.create({ content: 'x', due: '2026-11-11', time: '25:99' }), /Neplatný čas/);
  await assert.rejects(td.create({ content: 'x', due: '2026-13-45' }), /Neplatné datum/);
  await assert.rejects(td.create({ content: 'x', due: '2026-02-31' }), /Neplatné datum/);
  await assert.rejects(td.create({ content: 'x', due: '2026-13-45', time: '14:00' }), /Neplatné datum/);

  snap = await td.setDue('t3', '2026-12-01');
  assert.equal(snap.tasks.find((t) => t.id === 't3').due, '2026-12-01');
  snap = await td.setDue('t1', null);
  assert.equal(api.calls.at(-1).body.due_string, 'no date');
  assert.equal(snap.tasks.find((t) => t.id === 't1').due, null);
  await assert.rejects(td.setDue('t1', 'zítra'), /Neplatné datum/);
  await assert.rejects(td.setDue('missing', '2026-12-01'), /už neexistuje/);

  snap = await td.close('t2');
  assert.ok(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/tasks/t2/close'));
  assert.ok(!snap.tasks.some((t) => t.id === 't2'));
  await td.syncing;
  assert.ok(!td.tasks.some((t) => t.id === 't2'));

  const cleared = td.clearToken();
  assert.equal(cleared.configured, false);
  assert.deepEqual(cleared.tasks, []);
});
