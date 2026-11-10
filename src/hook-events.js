'use strict';
/** Pure translation of Claude Code hook payloads into office events (no Electron, unit-tested). */
const { VALID_TTY } = require('./focus');

const oneLine = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const basename = (p) => (p ? String(p).split('/').filter(Boolean).pop() ?? '' : '');
/**
 * One employee per project: a worktree belongs to its repository (/repo/.claude/worktrees/x/sub → /repo)
 * and all project-less Claude desktop chats share one desk (…/Claude/scratch-workspaces/<id>/… → …/scratch-workspaces).
 */
const projectRoot = (cwd) => String(cwd ?? '')
  .replace(/\/\.(?:claude\/)?worktrees\/[^/]+(?:\/.*)?$/, '')
  .replace(/(\/scratch-workspaces)\/.*$/, '$1');

function describeTool(tool, input) {
  switch (tool) {
    case 'Bash': return oneLine(input.command, 48);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return basename(input.file_path || input.notebook_path);
    case 'Grep': case 'Glob': return oneLine(input.pattern, 40);
    case 'WebSearch': return oneLine(input.query, 48);
    case 'WebFetch':
      try { return new URL(input.url).host; } catch { return 'web'; }
    case 'TodoWrite': return 'plánuje';
    default: return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool;
  }
}

/** Tool → statistics category. */
function toolCategory(tool) {
  if (/^(Bash|BashOutput|KillShell|KillBash)$/.test(tool)) return 'terminal';
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'reading';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'editing';
  if (/^Web/.test(tool)) return 'web';
  if (tool.startsWith('mcp__')) return 'mcp';
  if (tool === 'TodoWrite' || /PlanMode$/.test(tool)) return 'planning';
  if (tool === 'Task' || tool === 'Agent') return 'agents';
  return 'other';
}

/** git commit / push in a successful Bash call → office celebration. */
function celebrationFor(tool, input) {
  if (tool !== 'Bash') return null;
  const cmd = String(input?.command ?? '');
  // global options may take a value: git -C repo push, git -c k=v commit
  const sub = (name) => new RegExp(`\\bgit\\s+(?:-\\S+(?:\\s+[^-\\s]\\S*)?\\s+)*${name}\\b`);
  if (sub('push').test(cmd)) return 'push';
  if (sub('commit').test(cmd)) return 'commit';
  return null;
}

/** Claude Code hook payload → office event (or null when irrelevant). */
function normalize(raw) {
  const kind = raw?.hook_event_name;
  const sessionId = raw?.session_id;
  if (!kind || !sessionId) return null;

  const ev = {
    sessionId, cwd: raw.cwd || '', source: 'Claude', ts: Date.now(),
    mode: raw.permission_mode || null,
    tty: VALID_TTY.test(String(raw.office_tty)) ? raw.office_tty : null,
  };
  const tool = String(raw.tool_name || '');
  const isAgent = tool === 'Task' || tool === 'Agent';

  switch (kind) {
    case 'SessionStart': return { ...ev, type: 'join' };
    case 'SessionEnd': return { ...ev, type: 'leave' };
    case 'UserPromptSubmit': return { ...ev, type: 'prompt', text: oneLine(raw.prompt) };
    case 'PreToolUse':
      return isAgent
        ? { ...ev, type: 'subStart', text: oneLine(raw.tool_input?.description || raw.tool_input?.subagent_type || 'subagent', 40) }
        : { ...ev, type: 'tool', tool, text: describeTool(tool, raw.tool_input || {}) };
    // Agent tool completion is tracked through SubagentStop (works for background agents too).
    case 'PostToolUse':
      return isAgent ? null : { ...ev, type: 'toolDone', tool, celebrate: celebrationFor(tool, raw.tool_input) };
    case 'PostToolUseFailure':
      if (isAgent) return null;
      if (raw.is_interrupt) return { ...ev, type: 'toolDone', tool };
      return { ...ev, type: 'error', tool, text: oneLine(raw.is_timeout ? 'timeout' : raw.error, 60) };
    case 'SubagentStop': return { ...ev, type: 'subStop' };
    case 'Notification': {
      const text = oneLine(raw.message, 120);
      if (/permission|approve/i.test(text)) return { ...ev, type: 'waiting', text };
      if (/waiting for your input|idle/i.test(text)) return { ...ev, type: 'idle', text };
      return { ...ev, type: 'notice', text };
    }
    case 'Stop': return { ...ev, type: 'done' };
    case 'StopFailure': {
      const reason = oneLine(raw.error_type ?? raw.error ?? raw.reason ?? 'api error', 40);
      return { ...ev, type: 'failure', text: reason, limit: /rate.?limit/i.test(`${reason} ${JSON.stringify(raw)}`) };
    }
    default: return null;
  }
}

function sessionKey(ev) {
  // Claude: one employee per project folder (worktrees included). Other AIs: one employee per tool. Demo: never persisted.
  if (ev.sessionId.startsWith('demo-')) return `demo:${ev.cwd || ev.sessionId}`;
  return ev.source === 'Claude' ? (projectRoot(ev.cwd) || ev.sessionId) : `ai:${ev.source}`;
}

module.exports = { oneLine, basename, projectRoot, describeTool, toolCategory, celebrationFor, normalize, sessionKey };
