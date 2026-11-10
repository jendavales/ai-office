'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRoot } = require('../src/project');

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
