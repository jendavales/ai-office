'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRoot } = require('../src/project');
const { Store } = require('../src/store');

/** repo/ (.git dir) with api/src, a linked worktree elsewhere, a submodule and a plain folder. */
function layout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-project-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'api', 'src'), { recursive: true });
  const wt = path.join(base, 'repo-wt');
  fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  const sub = path.join(repo, 'vendor', 'lib');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');
  const plain = path.join(base, 'notes');
  fs.mkdirSync(plain);
  return { repo, wt, sub, plain };
}

test('a repository subfolder or worktree belongs to the repository', () => {
  const { repo, wt, sub, plain } = layout();
  assert.equal(projectRoot(repo), repo);
  assert.equal(projectRoot(path.join(repo, 'api', 'src')), repo);
  assert.equal(projectRoot(path.join(repo, 'api', 'gone')), repo); // deleted folders still resolve via their parents
  assert.equal(projectRoot(path.join(wt, 'lib')), repo); // linked worktree outside the repository
  assert.equal(projectRoot(sub), sub); // a submodule is a project of its own
  assert.equal(projectRoot(plain), plain);
  assert.equal(projectRoot(''), '');
});

test('employees saved under a subfolder move to their repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  const main = store.profile('/r', 'r');
  store.recordDone('/r', 1000);
  store.profile('/r/api', 'api').since = 1;
  store.recordTool('/r/api', 'editing');
  store.recordDone('/r/api', 2000);
  const second = store.profile('/r/api|2', 'api', { project: '/r/api', slot: 2 });
  const sub = store.profile('/x/sub', 'sub');
  store.recordDone('/x/sub', 500);
  store.profile('demo:/r/api', 'demo');

  const moved = store.rekey((project) => ({ '/r/api': '/r', '/x/sub': '/x' })[project] ?? null);
  assert.equal(moved, 3);
  assert.deepEqual(Object.keys(store.data.profiles).sort(), ['/r', '/r|2', '/x', 'demo:/r/api']);
  // the repository's own member takes over the subfolder member's career…
  const r = store.publicProfile('/r');
  assert.deepEqual([r.name, r.label, r.done, r.xp], [main.name, 'r', 2, 21]);
  assert.equal(store.data.profiles['/r'].since, 1);
  // …while members the repository didn't have yet move over with their name
  assert.deepEqual([store.publicProfile('/r|2').name, store.publicProfile('/r|2').project], [second.name, '/r']);
  assert.deepEqual([store.publicProfile('/x').name, store.publicProfile('/x').label], [sub.name, 'x']);
  const row = new Store(dir).stats().today.find((s) => s.key === '/r');
  assert.deepEqual([row.done, row.workMs, row.tools], [2, 3000, { editing: 1 }]);
  assert.deepEqual(new Store(dir).stats().total.find((s) => s.key === '/r').tools, { editing: 1 });
});
