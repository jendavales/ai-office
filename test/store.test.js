'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, LEVELS, NAMES, pickName, employeeKey, freeMember, accusative } = require('../src/store');

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-')));

test('employees keep their own lasting, unique name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  const a = store.profile('/p/eshop', 'eshop');
  const b = store.profile(employeeKey('/p/eshop', 2), 'eshop', { project: '/p/eshop', slot: 2 });
  assert.equal(store.profile('/p/eshop', 'eshop'), a);
  assert.ok(NAMES.includes(a.name));
  assert.notEqual(a.name, b.name);
  assert.deepEqual([b.project, b.slot, store.publicProfile('/p/eshop|2').name], ['/p/eshop', 2, b.name]);
  store.flush();
  assert.equal(new Store(dir).publicProfile('/p/eshop').name, a.name);
});

test('a parallel session gets the next free member of the project team', () => {
  assert.deepEqual(freeMember('/p/x', new Set()), { key: '/p/x', slot: 1 });
  assert.deepEqual(freeMember('/p/x', new Set(['/p/x', '/p/y'])), { key: '/p/x|2', slot: 2 });
  assert.deepEqual(freeMember('/p/x', new Set(['/p/x|2'])), { key: '/p/x', slot: 1 }); // the main one comes back first
  assert.deepEqual(freeMember('/p/x', new Set(['/p/x', '/p/x|2'])), { key: '/p/x|3', slot: 3 });
});

test('profiles saved without names or teams get them on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  fs.writeFileSync(path.join(dir, 'office-data.json'), JSON.stringify({
    profiles: { '/p/a': { name: 'Ruda', label: 'a', xp: 5, done: 0, since: 1 }, '/p/b': { label: 'b', xp: 0, done: 0, since: 2 } },
    days: {},
  }));
  const store = new Store(dir);
  assert.equal(store.publicProfile('/p/a').name, 'Ruda');
  const b = store.data.profiles['/p/b'];
  assert.ok(NAMES.includes(b.name) && b.name !== 'Ruda');
  assert.deepEqual([b.project, b.slot], ['/p/b', 1]);
});

test('random names avoid names already in the office', () => {
  const used = new Set(NAMES.slice(1));
  assert.equal(pickName(used), NAMES[0]);
  const all = new Set(NAMES);
  const name = pickName(all, () => 0);
  assert.equal(name, `${NAMES[0]} 2`);
  assert.equal(pickName(new Set([...all, name]), () => 0), `${NAMES[0]} 3`);
});

test('XP and promotion', () => {
  const store = tmpStore();
  store.profile('/p/x', 'x');
  let promoted = null;
  for (let i = 0; i < LEVELS[1].xp; i++) promoted = store.recordTool('/p/x', 'terminal') ?? promoted;
  assert.equal(promoted, 1);
  const p = store.publicProfile('/p/x');
  assert.equal(p.title, LEVELS[1].title);
  assert.equal(p.nextXp, LEVELS[2].xp);
});

test('daily stats per employee, employee and project of the week', () => {
  const store = tmpStore();
  store.profile('/p/a', 'a');
  store.profile('/p/a|2', 'a', { project: '/p/a', slot: 2 });
  store.profile('/p/b', 'b');
  store.recordDone('/p/a', 60_000);
  store.recordDone('/p/a|2', 1000);
  store.recordDone('/p/a|2', 1000);
  store.recordDone('/p/b', 30_000);
  store.recordDone('/p/b', 30_000);
  store.recordCost('/p/b', 1.25);
  store.recordTool('/p/b', 'editing');
  const stats = store.stats();
  assert.equal(stats.today.length, 3); // one row per employee, the team of /p/a has two
  assert.equal(stats.employeeOfWeek.key, '/p/b');
  assert.equal(stats.employeeOfWeek.name, store.data.profiles['/p/b'].name);
  // /p/b ties with /p/a|2 on tasks and wins on working time; the project counts its whole team (1 + 2 tasks)
  assert.deepEqual(stats.projectOfWeek, { key: '/p/a', label: 'a', done: 3, people: 2 });
  const b = stats.today.find((r) => r.key === '/p/b');
  assert.deepEqual([b.done, b.workMs, b.cost, b.tools.editing], [2, 60_000, 1.25, 1]);
});

test('ignores absurd values', () => {
  const store = tmpStore();
  store.profile('/p/a', 'a');
  store.recordWork('/p/a', -5);
  store.recordWork('/p/a', 48 * 3_600_000);
  store.recordCost('/p/a', -1);
  const row = store.stats().today.find((r) => r.key === '/p/a');
  assert.equal(row?.workMs ?? 0, 0);
  assert.equal(row?.cost ?? 0, 0);
});

test('persists real data but never demo sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  store.profile('/p/real', 'real');
  store.profile('demo:/p/fake', 'fake');
  store.recordDone('/p/real', 1000);
  store.recordDone('demo:/p/fake', 1000);
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'office-data.json'), 'utf8'));
  assert.ok(saved.profiles['/p/real']);
  assert.equal(saved.profiles['demo:/p/fake'], undefined);
  assert.ok(Object.values(saved.days).every((perKey) => !perKey['demo:/p/fake']));
  const reloaded = new Store(dir);
  assert.equal(reloaded.publicProfile('/p/real').done, 1);
});

test('all-time totals list every project and outlive pruned days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  store.profile('/p/a', 'a');
  store.profile('/p/idle', 'idle');
  store.profile('demo:/p/fake', 'fake');
  store.recordTool('/p/a', 'editing');
  store.recordDone('/p/a', 60_000);
  store.recordCost('/p/a', 0.5);
  const old = { done: 3, tools: { terminal: 7 }, workMs: 3_600_000, cost: 2 };
  store.importHistory({
    until: Date.now(), sessions: 1,
    projects: { '/p/old': { label: 'old', since: Date.UTC(2020, 0, 1), done: 3, xp: 37, workMs: old.workMs, cost: old.cost } },
    days: { '2020-01-01': { '/p/old': old } },
  });
  assert.equal(store.data.days['2020-01-01'], undefined); // pruned after KEEP_DAYS…
  const rows = new Store(dir).stats().total;
  assert.deepEqual(rows.map((r) => r.key), ['/p/old', '/p/a', '/p/idle']); // …but the totals stay; demo is left out
  assert.deepEqual((({ done, workMs, cost, tools }) => ({ done, workMs, cost, tools }))(rows[0]), { done: 3, workMs: 3_600_000, cost: 2, tools: { terminal: 7 } });
  assert.deepEqual([rows[1].workMs, rows[1].cost, rows[1].tools], [60_000, 0.5, { editing: 1 }]);
  assert.equal(rows[0].since, Date.UTC(2020, 0, 1));
});

test('profiles saved before totals existed start from their kept days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, 'office-data.json'), JSON.stringify({
    profiles: { '/p/a': { name: 'Pepa', label: 'a', xp: 11, done: 1, since: 1 } },
    days: { [today]: { '/p/a': { done: 1, tools: { reading: 1 }, workMs: 5000, cost: 0.25 } } },
  }));
  const row = new Store(dir).stats().total[0];
  assert.deepEqual([row.workMs, row.cost, row.tools], [5000, 0.25, { reading: 1 }]);
});

test('project folders for a new task: real repositories, most recent first, team members counted once', () => {
  const store = tmpStore();
  store.profile('/p/eshop', 'eshop');
  store.profile(employeeKey('/p/eshop', 2), 'eshop', { project: '/p/eshop', slot: 2 });
  store.profile('/p/blog', 'blog');
  store.profile('/Users/x/Library/Application Support/Claude/scratch-workspaces', 'scratch-workspaces');
  store.profile('/private/tmp/run', 'run');
  store.profile('ai:Codex', 'Codex');
  store.data.days['2026-01-01'] = { '/p/eshop': { done: 1, tools: {}, workMs: 0, cost: 0 } };
  store.data.days['2099-01-01'] = { '/p/blog': { done: 1, tools: {}, workMs: 0, cost: 0 } };
  assert.deepEqual(store.projects().map((p) => [p.path, p.label]), [['/p/blog', 'blog'], ['/p/eshop', 'eshop']]);
});

test('a conversation keeps its owner: back to them when free, a colleague covers while they are busy', () => {
  const store = tmpStore();
  const owner = { key: '/p/x|2', slot: 2 };
  // first time in the office: the first free member takes it and becomes its owner
  assert.deepEqual(store.assignMember('/p/x', 's1', new Set(['/p/x'])), { ...owner, owner, substitute: false });
  // back later (restart, 🏠 Domů): the owner again, although member 1 is free by now
  assert.deepEqual(store.assignMember('/p/x', 's1', new Set()), { ...owner, owner, substitute: false });
  // the owner works in another session: the first free colleague covers, the conversation stays theirs
  assert.deepEqual(store.assignMember('/p/x', 's1', new Set(['/p/x|2'])), { key: '/p/x', slot: 1, owner, substitute: true });
  assert.deepEqual(store.assignMember('/p/x', 's1', new Set(['/p/x|2', '/p/x'])), { key: '/p/x|3', slot: 3, owner, substitute: true });
  assert.equal(store.ownerOf('s1').key, '/p/x|2');
  assert.equal(store.ownerOf('nope'), null);
  // not a conversation (another AI's process): just the free member, nothing remembered
  assert.deepEqual(store.assignMember('ai:Codex', null, new Set()), { key: 'ai:Codex', slot: 1, owner: null, substitute: false });
});

test('an owner from another project is replaced; branches and rewinds inherit the owner', () => {
  const store = tmpStore();
  store.assignMember('/p/old', 's1', new Set(['/p/old']));
  const moved = store.assignMember('/p/new', 's1', new Set());
  assert.deepEqual([moved.key, moved.substitute], ['/p/new', false]);
  assert.deepEqual([store.ownerOf('s1').key, store.ownerOf('s1').project], ['/p/new', '/p/new']);
  store.assignMember('/p/a', 'orig', new Set(['/p/a']));
  assert.equal(store.inheritOwner('orig', 'fork').key, '/p/a|2');
  assert.deepEqual(store.assignMember('/p/a', 'fork', new Set()), { key: '/p/a|2', slot: 2, owner: { key: '/p/a|2', slot: 2 }, substitute: false });
  assert.equal(store.inheritOwner('unknown', 'fork2'), null);
  assert.equal(store.ownerOf('fork2'), null);
});

test('owners are saved (demo ones never), the least recently seen are dropped first, rekey moves them along', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  store.setOwner('s1', { key: '/p/x|2', slot: 2, project: '/p/x' });
  store.setOwner('demo-1', { key: 'demo:/p/fake', project: 'demo:/p/fake' });
  store.flush();
  const reloaded = new Store(dir);
  assert.deepEqual((({ key, slot, project }) => ({ key, slot, project }))(reloaded.ownerOf('s1')), { key: '/p/x|2', slot: 2, project: '/p/x' });
  assert.equal(reloaded.ownerOf('demo-1'), null);

  store.data.owners = { a: { key: '/p/x', lastSeen: 3 }, b: { key: '/p/x', lastSeen: 1 }, c: { key: '/p/x', lastSeen: 2 } };
  store.pruneOwners(2);
  assert.deepEqual(Object.keys(store.data.owners).sort(), ['a', 'c']);

  store.profile('/p/repo/sub|2', 'sub', { project: '/p/repo/sub', slot: 2 });
  store.setOwner('s2', { key: '/p/repo/sub|2', slot: 2, project: '/p/repo/sub' });
  store.rekey((p) => (p === '/p/repo/sub' ? '/p/repo' : null));
  assert.deepEqual([store.ownerOf('s2').key, store.ownerOf('s2').project], ['/p/repo|2', '/p/repo']);
});

test('the covered-for owner is named, never created, and declined: zastupuje Vencu', () => {
  const store = tmpStore();
  assert.equal(store.nameTag('/p/nobody'), null);
  assert.equal(store.data.profiles['/p/nobody'], undefined);
  const p = store.profile('/p/x', 'x');
  p.name = 'Venca';
  assert.deepEqual(store.nameTag('/p/x'), { key: '/p/x', name: 'Venca', whom: 'Vencu' });
  assert.deepEqual(['Mirek', 'Karel', 'Bohouš', 'Eva', 'Pepa 2', 'Petr'].map(accusative), ['Mirka', 'Karla', 'Bohouše', 'Evu', 'Pepu 2', 'Petra']);
});
