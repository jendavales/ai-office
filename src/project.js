'use strict';
/**
 * Which project a working directory belongs to – one career per project, wherever in it Claude runs:
 *  - any subfolder of a git repository → the repository (/repo/api/src → /repo)
 *  - a git worktree → its main repository, also when the worktree folder is gone (/repo/.claude/worktrees/x → /repo)
 *  - all project-less Claude desktop chats → one shared project (…/Claude/scratch-workspaces/<id>/… → …/scratch-workspaces)
 *  - anything else stays as it is
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roots = new Map(); // dir -> repository root or null (folders don't move between repos while we run)

/** Main repository of a worktree whose .git file points to <repo>/.git/worktrees/<name>, else null. */
function worktreeMain(gitFile) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    const gitdir = m && path.resolve(path.dirname(gitFile), m[1]);
    const at = gitdir ? gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`) : -1;
    return at > 0 ? gitdir.slice(0, at) : null;
  } catch {
    return null;
  }
}

/** Nearest folder at or above `dir` with a .git, below the home folder (a dotfiles repo in ~ is no project). */
function gitRoot(dir) {
  if (roots.has(dir)) return roots.get(dir);
  const home = os.homedir();
  let root = null;
  for (let d = dir; d !== home && d !== path.dirname(d); d = path.dirname(d)) {
    const git = path.join(d, '.git');
    let stat;
    try {
      stat = fs.statSync(git);
    } catch {
      continue;
    }
    root = (stat.isFile() && worktreeMain(git)) || d;
    break;
  }
  roots.set(dir, root);
  return root;
}

function projectRoot(cwd) {
  const dir = String(cwd ?? '')
    .replace(/\/\.(?:claude\/)?worktrees\/[^/]+(?:\/.*)?$/, '')
    .replace(/(\/scratch-workspaces)\/.*$/, '$1');
  if (!path.isAbsolute(dir) || dir.endsWith('/scratch-workspaces')) return dir;
  return gitRoot(dir) ?? dir;
}

module.exports = { projectRoot };
