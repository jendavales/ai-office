'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, LEVELS, NAMES, pickName } = require('../src/store');

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-')));

test('project profiles carry no employee name', () => {
  const store = tmpStore();
  const a = store.profile('/p/eshop', 'eshop');
  assert.equal(store.profile('/p/eshop', 'eshop'), a);
  assert.equal(a.name, undefined);
  assert.equal(store.publicProfile('/p/eshop').name, undefined);
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

test('daily stats and project of the week', () => {
  const store = tmpStore();
  store.profile('/p/a', 'a');
  store.profile('/p/b', 'b');
  store.recordDone('/p/a', 60_000);
  store.recordDone('/p/b', 30_000);
  store.recordDone('/p/b', 30_000);
  store.recordCost('/p/b', 1.25);
  store.recordTool('/p/b', 'editing');
  const stats = store.stats();
  assert.equal(stats.today.length, 2);
  assert.equal(stats.projectOfWeek.key, '/p/b');
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
