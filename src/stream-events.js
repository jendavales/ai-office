'use strict';
/**
 * One conversation as a list of items, built from Claude Code's stream-json output
 * (`claude -p --output-format stream-json`) or from a saved transcript (~/.claude/projects/…/<id>.jsonl).
 * Both use the same message shapes, so a conversation reloaded after a restart looks like a live one.
 * Shown the way Claude's desktop app shows it: what you wrote and what Claude did – not the system reminders,
 * skill contents, hook output, command echoes and summaries Claude Code mixes into the transcript.
 * Pure logic (unit-tested). Unknown message types are ignored: the format grows between Claude Code versions.
 * Everything is shortened: items travel over IPC and stay in memory.
 *
 * Items:
 *   { kind: 'user', text, uuid?, images?, truncated? } – your message; uuid of its transcript entry when known,
 *                                                       images = attached pictures, truncated = text shortened
 *   { kind: 'text', text, done }                 – Claude's reply (markdown), streamed while done = false
 *   { kind: 'thinking', text, done }             – Claude's thinking (when Claude Code passes it on), shortened
 *   { kind: 'tool', toolId, name, label, status, input, output }
 *                                                – a tool call, status run | ok | err | stop; input / output are
 *                                                  short readable excerpts or null
 *   { kind: 'notice', tone, text }               – something worth knowing (tone info | warn | error)
 *   { kind: 'done', ms, cost, error }            – end of a turn
 *
 * Your messages come in the order of your prompts in the transcript (fork/rewind relies on it): typed prompts,
 * slash commands ("/name args") and messages sent while Claude worked (queued_command attachments).
 */
const { describeTool, oneLine } = require('./hook-events');

const LIMIT = { input: 600, output: 800, thinking: 2000, paste: 1500, user: 10000, line: 160 };

function createConversation() {
  return {
    items: [], busy: false, activity: '', title: '', summary: '', model: null, mode: null,
    customTitle: '', agentName: '', aiTitle: '', live: -1, think: -1, tools: {}, compactUuid: null,
  };
}

function push(conv, item, changed) {
  conv.items.push(item);
  changed.push(conv.items.length - 1);
  return conv.items.length - 1;
}

/** At most n characters, '…' when cut (never in the middle of a surrogate pair). */
function clip(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  let cut = t.slice(0, n - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------------------------
// Your messages

// added by Claude Code for the model, anywhere in a message – only the block goes, the rest stays
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;
// command output, caveats and hook output – never shown
const HIDDEN = /<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|user-prompt-submit-hook|tools-used-before-summary)>[\s\S]*?<\/\1>\s*/g;
const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;
// a whole message in one tag of Claude Code's (they all have a - or _ in the name): something not written by you
const WRAPPED = /^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1\s*>$/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/;
const COMPACTED = 'Kontext zkomprimován';

const tagText = (s, tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1]?.trim();
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);

/** <command-name>/review</command-name><command-args>…</command-args> → "/review …" (a skill or slash command). */
function slashCommand(s) {
  let name = tagText(s, 'command-name');
  if (!name) {
    const message = tagText(s, 'command-message');
    if (message && /^[\w:.-]+$/.test(message)) name = message;
  }
  if (!name) return null;
  const args = tagText(s, 'command-args') ?? '';
  return `/${name.replace(/^\//, '')}${args ? ` ${args}` : ''}`;
}

/** Background task finished – Claude is told with a message of its own; you see one line. */
function taskNotices(s) {
  const notices = [];
  for (const [, body] of s.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const status = tagText(body, 'status') ?? '';
    const summary = decode(tagText(body, 'summary'));
    notices.push({
      kind: 'notice',
      tone: /fail|error|kill/i.test(status) ? 'warn' : 'info',
      text: oneLine(summary || `Úloha na pozadí: ${status || 'hotovo'}`, 200),
    });
  }
  return notices;
}

/** A message from another Claude session (the desktop app links them) – a line, not a message of yours. */
function sessionNotices(s) {
  const notices = [];
  for (const [, attrs, body] of s.matchAll(/<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/g)) {
    const from = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] || /\bfrom="([^"]*)"/.exec(attrs)?.[1] || 'jiná session');
    notices.push({ kind: 'notice', tone: 'info', text: oneLine(`Zpráva od „${from}“: ${body}`, 200) });
  }
  return notices;
}

/**
 * What a user entry's text is to you: { text, truncated } – your message (cleaned up),
 * { notices } – a line to show instead, { compact: true } – a compaction summary, or null – nothing at all.
 */
function readUserText(raw) {
  let s = String(raw ?? '').replace(REMINDER, '').replace(HIDDEN, '').trim();
  if (!s) return null;
  if (INTERRUPTED.test(s)) return { notices: [{ kind: 'notice', tone: 'info', text: 'Přerušeno.' }] };
  if (s.startsWith('<task-notification>')) return { notices: taskNotices(s) };
  if (s.startsWith('<cross-session-message')) return { notices: sessionNotices(s) };
  if (COMPACT_SUMMARY.test(s)) return { compact: true };
  if (/^<command-(name|message)>/.test(s)) s = slashCommand(s) ?? '';
  else if (s.startsWith('<bash-input>')) s = `! ${tagText(s, 'bash-input') ?? ''}`;
  else {
    const tag = WRAPPED.exec(s)?.[1];
    if (tag && /[-_]/.test(tag) && tag !== 'pasted_content') return null;
  }
  let truncated = false;
  s = s.replace(PASTED, (_, inner) => {
    const t = inner.trim();
    if (t.length > LIMIT.paste) truncated = true;
    return clip(t, LIMIT.paste);
  }).trim();
  if (s.length > LIMIT.user) {
    truncated = true;
    s = clip(s, LIMIT.user);
  }
  return s ? { text: s, truncated } : null;
}

/** One notice for a compaction (its boundary and its summary both say so); uuid = the entry it starts with. */
function compacted(conv, changed, uuid = null) {
  const last = conv.items[conv.items.length - 1];
  if (last?.kind === 'notice' && last.text === COMPACTED) return;
  push(conv, { kind: 'notice', tone: 'info', text: COMPACTED }, changed);
  conv.compactUuid = uuid;
}

function userText(conv, raw, changed, { uuid = null, images = 0 } = {}) {
  const read = readUserText(raw);
  if (read?.notices) {
    for (const n of read.notices) push(conv, n, changed);
    return;
  }
  if (read?.compact) {
    compacted(conv, changed, uuid);
    return;
  }
  if (!read && !images) return;
  const item = { kind: 'user', text: read?.text ?? '' };
  if (uuid) item.uuid = uuid;
  if (images) item.images = images;
  if (read?.truncated) item.truncated = true;
  conv.title ||= oneLine(item.text, 60);
  const last = conv.items.length - 1;
  if (/^\/compact\b/.test(item.text) && conv.items[last]?.kind === 'notice' && conv.items[last].text === COMPACTED) {
    // Claude Code writes /compact down after its result – shown in the order it happened, as when live, and
    // starting where the compaction does: a rewind to before /compact gets the conversation back uncompacted
    if (item.uuid && conv.compactUuid) item.uuid = conv.compactUuid;
    push(conv, conv.items[last], changed);
    conv.items[last] = item;
    changed.push(last);
    return;
  }
  push(conv, item, changed);
}

/** Your own message. Live messages aren't echoed back by Claude Code, so the caller adds them when sending. */
function addUser(conv, text, changed = []) {
  userText(conv, text, changed);
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Tools

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toolLabel(name, input) {
  if (name === 'Agent' || name === 'Task') return oneLine(input.description || input.subagent_type || 'subagent', 60);
  if (name === 'Skill') return oneLine(input.skill || input.command || 'skill', 60);
  if (name === 'ToolSearch') return oneLine(input.query, 48) || name;
  if (name.startsWith('mcp__')) {
    // claude.ai connectors are servers named by an id – the tool's own name says more
    const [, server = '', ...rest] = name.split('__');
    return UUIDISH.test(server) && rest.length ? rest.join('__') : name.split('__').slice(1).join(' · ');
  }
  return describeTool(name, input);
}

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** First lines of a text, each shortened, with a prefix (a diff's - / +). */
function excerpt(text, max, prefix = '') {
  const s = str(text);
  if (!s) return '';
  const all = s.split('\n');
  const out = all.slice(0, max).map((l) => prefix + clip(l, LIMIT.line));
  if (all.length > max) out.push(`${prefix}…`);
  return out.join('\n');
}

/** Remaining arguments as "key: value" lines. */
function fields(input, skip = []) {
  return Object.entries(input)
    .filter(([k, v]) => !skip.includes(k) && v != null && v !== '' && v !== false)
    .map(([k, v]) => `${k}: ${clip(typeof v === 'string' ? oneLine(v, 400) : JSON.stringify(v), 200)}`);
}

function readRange({ offset, limit, pages }) {
  if (pages) return `(strany ${pages})`;
  const from = Number(offset) || 0;
  const n = Number(limit) || 0;
  if (from && n) return `(řádky ${from}–${from + n - 1})`;
  if (from) return `(od řádku ${from})`;
  return n ? `(řádky 1–${n})` : '';
}

const TODO = { completed: '☑', in_progress: '◐', pending: '☐' };
const list = (v) => (Array.isArray(v) ? v : []);
const checklist = (todos) => todos.map((t) => `${TODO[t?.status] ?? '☐'} ${oneLine(t?.content, 120)}`);

/** What a tool was asked to do, readable and short (null when there's nothing to say). */
function toolInput(name, input) {
  let parts;
  switch (name) {
    case 'Bash':
      parts = [str(input.command), input.run_in_background ? '(na pozadí)' : ''];
      break;
    case 'Read':
      parts = [`${str(input.file_path)} ${readRange(input)}`];
      break;
    case 'Edit':
      parts = [str(input.file_path) + (input.replace_all ? ' (všechny výskyty)' : ''), excerpt(input.old_string, 6, '- '), excerpt(input.new_string, 6, '+ ')];
      break;
    case 'MultiEdit':
      parts = [str(input.file_path), ...list(input.edits).flatMap((e) => [excerpt(e?.old_string, 3, '- '), excerpt(e?.new_string, 3, '+ ')])];
      break;
    case 'Write':
      parts = [str(input.file_path), excerpt(input.content, 8)];
      break;
    case 'NotebookEdit':
      parts = [str(input.notebook_path) + (input.cell_id ? ` · ${input.cell_id}` : '') + (input.edit_mode ? ` (${input.edit_mode})` : ''), excerpt(input.new_source, 8)];
      break;
    case 'Grep': case 'Glob':
      parts = [str(input.pattern), ...fields(input, ['pattern'])];
      break;
    case 'WebFetch':
      parts = [str(input.url), oneLine(input.prompt, 300)];
      break;
    case 'WebSearch': case 'ToolSearch':
      parts = [str(input.query), ...fields(input, ['query'])];
      break;
    case 'Agent': case 'Task':
      parts = [(input.subagent_type ? `[${input.subagent_type}] ` : '') + str(input.description), '', excerpt(input.prompt, 12)];
      break;
    case 'Skill':
      parts = [[str(input.skill || input.command), str(input.args)].filter(Boolean).join(' ')];
      break;
    case 'TodoWrite':
      parts = checklist(list(input.todos));
      break;
    case 'AskUserQuestion':
      parts = list(input.questions).flatMap((q) => [oneLine(q?.question, 200), ...list(q?.options).map((o) => `  • ${oneLine(o?.label, 100)}`)]);
      break;
    case 'ExitPlanMode':
      parts = [excerpt(input.plan, 12)];
      break;
    default: {
      // a plan of steps (the desktop app's update_plan) reads like TodoWrite's
      const plan = list(input.todos ?? input.items);
      parts = plan.length && plan.every((t) => typeof t?.content === 'string') ? checklist(plan) : fields(input);
    }
  }
  const out = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out ? clip(out, LIMIT.input) : null;
}

// tools whose result is content Claude reads (a skill's instructions, a file, a page) – not shown, like in Claude
const CONTENT_TOOLS = new Set(['Skill', 'ToolSearch', 'Read', 'NotebookRead', 'WebFetch', 'ReadMcpResourceTool']);

/** The start of a tool's result text (no pictures), or null. */
function toolOutput(name, block) {
  if (name === 'Skill') return null; // the skill's contents, never – not even its errors
  if (CONTENT_TOOLS.has(name) && !block.is_error) return null;
  const c = block.content;
  const raw = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => str(b.text)).join('\n') : '';
  const text = raw.slice(0, LIMIT.output * 25)
    .replace(REMINDER, '')
    .replace(/<system-reminder>[\s\S]*$/, '') // cut off above
    .replace(/<\/?(tool_use_error|persisted-output)>/g, '')
    .trim();
  return text ? clip(text, LIMIT.output) : null;
}

function toolUse(conv, block, changed) {
  const name = str(block.name) || 'tool';
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const item = { kind: 'tool', toolId: block.id, name, label: toolLabel(name, input), status: 'run', input: toolInput(name, input), output: null };
  conv.tools[block.id] = push(conv, item, changed);
}

function toolResult(conv, block, changed) {
  const idx = conv.tools[block.tool_use_id];
  if (idx == null) return;
  const item = conv.items[idx];
  item.status = block.is_error ? 'err' : 'ok';
  item.output = toolOutput(item.name, block);
  changed.push(idx);
}

// ---------------------------------------------------------------------------------------------------------------
// Claude

function endText(conv, changed) {
  if (conv.live < 0) return;
  conv.items[conv.live].done = true;
  changed.push(conv.live);
  conv.live = -1;
}

function endThinking(conv, changed) {
  if (conv.think < 0) return;
  conv.items[conv.think].done = true;
  changed.push(conv.think);
  conv.think = -1;
}

function thinkingDelta(conv, text, changed) {
  if (!text) return; // Claude Code may stream only that it thinks, not what
  if (conv.think < 0) conv.think = push(conv, { kind: 'thinking', text: '', done: false }, changed);
  const item = conv.items[conv.think];
  if (item.text.length >= LIMIT.thinking) return;
  item.text = clip(item.text + text, LIMIT.thinking);
  changed.push(conv.think);
}

function thinkingBlock(conv, text, changed) {
  const full = str(text).trim();
  const live = conv.think >= 0 ? conv.items[conv.think] : null;
  if (live) {
    if (full) live.text = clip(full, LIMIT.thinking); // the complete block replaces the streamed deltas
    endThinking(conv, changed);
  } else if (full) {
    push(conv, { kind: 'thinking', text: clip(full, LIMIT.thinking), done: true }, changed);
  }
}

function streamEvent(conv, ev, changed) {
  if (!ev) return;
  if (ev.type === 'message_start') {
    conv.busy = true;
    endThinking(conv, changed);
  } else if (ev.type === 'content_block_start') {
    if (ev.content_block?.type === 'text') {
      endText(conv, changed);
      conv.live = push(conv, { kind: 'text', text: '', done: false }, changed);
    } else if (ev.content_block?.type === 'thinking') {
      endThinking(conv, changed);
    }
  } else if (ev.type === 'content_block_delta') {
    if (ev.delta?.type === 'text_delta' && conv.live >= 0) {
      conv.items[conv.live].text += ev.delta.text ?? '';
      changed.push(conv.live);
    } else if (ev.delta?.type === 'thinking_delta') {
      thinkingDelta(conv, ev.delta.thinking, changed);
    }
  }
}

function assistant(conv, msg, changed) {
  const message = msg.message;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  if (msg.isApiErrorMessage || msg.error) {
    // "API Error: …", "You've hit your limit …" – written by Claude Code, not by Claude
    endText(conv, changed);
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
    push(conv, { kind: 'notice', tone: 'error', text: oneLine(text || str(msg.error) || 'chyba API', 300) }, changed);
    return;
  }
  if (message?.model === '<synthetic>') return; // "No response requested." and the like
  for (const block of blocks) {
    if (block?.type === 'text') {
      const live = conv.live >= 0 ? conv.items[conv.live] : null;
      if (live && !live.done) {
        live.text = block.text ?? live.text; // the complete block replaces the streamed deltas
        endText(conv, changed);
      } else if (block.text?.trim()) {
        push(conv, { kind: 'text', text: block.text, done: true }, changed);
      }
    } else if (block?.type === 'thinking') {
      thinkingBlock(conv, block.thinking, changed);
    } else if (block?.type === 'tool_use') {
      toolUse(conv, block, changed);
    }
  }
}

function user(conv, msg, changed) {
  const content = msg.message?.content;
  const texts = [];
  let images = 0;
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_result') toolResult(conv, block, changed);
      else if (block?.type === 'text') texts.push(str(block.text));
      else if (block?.type === 'image') images += 1;
    }
  }
  // Claude Code's own additions: skill contents, caveats, image notes, "continue" nudges, messages of other agents
  if (msg.isMeta || msg.isSynthetic || msg.isReplay) return;
  if (msg.isCompactSummary) {
    compacted(conv, changed, msg.uuid);
    return;
  }
  if (texts.length || images) userText(conv, texts.join('\n'), changed, { uuid: msg.uuid, images });
}

/** Transcript attachments: only your messages sent while Claude worked (it read them mid-turn) are yours. */
function attachment(conv, msg, changed) {
  const a = msg.attachment;
  if (a?.type !== 'queued_command' || a.isMeta) return;
  if (a.commandMode && a.commandMode !== 'prompt' && a.commandMode !== 'task-notification') return;
  if (a.origin?.kind && a.origin.kind !== 'human' && a.origin.kind !== 'task-notification') return;
  const blocks = Array.isArray(a.prompt) ? a.prompt : [];
  const text = typeof a.prompt === 'string' ? a.prompt : blocks.filter((b) => b?.type === 'text').map((b) => str(b.text)).join('\n');
  userText(conv, text, changed, { uuid: msg.uuid, images: blocks.filter((b) => b?.type === 'image').length });
}

const TONES = { warning: 'warn', error: 'error' };

function system(conv, msg, changed) {
  switch (msg.subtype) {
    case 'init':
      conv.model = msg.model ?? conv.model;
      conv.mode = msg.permissionMode ?? conv.mode;
      break;
    case 'task_summary': conv.activity = msg.detail ? oneLine(msg.detail, 80) : ''; break;
    case 'post_turn_summary': conv.summary = oneLine(msg.status_detail, 120); break;
    case 'compact_boundary': compacted(conv, changed, msg.uuid); break;
    case 'informational': case 'model_refusal_fallback': {
      // e.g. "…'s safeguards stopped the response above"; idle compaction is already the compaction notice
      const text = typeof msg.content === 'string' ? oneLine(msg.content, 300) : '';
      if (text && !/^Compacted\b/.test(text)) {
        push(conv, { kind: 'notice', tone: TONES[msg.level] ?? (msg.subtype === 'informational' ? 'info' : 'warn'), text }, changed);
      }
      break;
    }
    default: break;
  }
}

function errorText(msg) {
  if (msg.subtype === 'error_during_execution') return 'přerušeno';
  return oneLine(typeof msg.result === 'string' && msg.result ? msg.result : msg.subtype || 'chyba', 200);
}

/** Tools left running when a turn ends (interrupt, crash) didn't finish. */
function settle(conv, changed) {
  endText(conv, changed);
  endThinking(conv, changed);
  conv.items.forEach((item, i) => {
    if (item.kind === 'tool' && item.status === 'run') {
      item.status = 'stop';
      changed.push(i);
    }
  });
}

function result(conv, msg, changed) {
  conv.busy = false;
  conv.activity = '';
  settle(conv, changed);
  for (const d of msg.permission_denials ?? []) {
    push(conv, { kind: 'notice', tone: 'warn', text: `Zamítnuto – nástroj potřeboval povolení: ${d.tool_name}` }, changed);
  }
  push(conv, {
    kind: 'done',
    ms: Number.isFinite(msg.duration_ms) ? msg.duration_ms : null,
    cost: Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : null,
    error: msg.is_error ? errorText(msg) : null,
  }, changed);
}

const titleOf = (v) => (typeof v === 'string' ? oneLine(v, 120) : null);

/** Applies one stream-json message or transcript entry; returns indices of the items it added or changed. */
function apply(conv, msg) {
  const changed = [];
  if (!msg || typeof msg !== 'object') return changed;
  // subagent internals aren't part of the conversation
  if (msg.parent_tool_use_id || msg.isSidechain) return changed;
  if (msg.isMeta && msg.type !== 'user') return changed;
  switch (msg.type) {
    case 'stream_event': streamEvent(conv, msg.event, changed); break;
    case 'assistant': assistant(conv, msg, changed); break;
    case 'user': user(conv, msg, changed); break;
    case 'attachment': attachment(conv, msg, changed); break;
    case 'system': system(conv, msg, changed); break;
    case 'result': result(conv, msg, changed); break;
    // names given to the session (the last one counts)
    case 'custom-title': conv.customTitle = titleOf(msg.customTitle) ?? conv.customTitle; break;
    case 'agent-name': conv.agentName = titleOf(msg.agentName) ?? conv.agentName; break;
    case 'ai-title': conv.aiTitle = titleOf(msg.aiTitle) ?? conv.aiTitle; break;
    default: break;
  }
  return [...new Set(changed)];
}

/**
 * Conversation from a saved transcript (JSONL text). Nothing is running, so whatever was open is settled.
 * An entry written twice (the desktop app may append a session's history again) counts once.
 */
function fromTranscript(text) {
  const conv = createConversation();
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg?.uuid) {
        if (seen.has(msg.uuid)) continue;
        seen.add(msg.uuid);
      }
      apply(conv, msg);
    } catch { /* torn last line while Claude was writing */ }
  }
  settle(conv, []);
  conv.busy = false;
  conv.activity = '';
  return conv;
}

/** rate_limit_event → the status-line shape the office already understands (rate_limits.five_hour / seven_day). */
function rateLimits(msg) {
  const w = msg?.rate_limit_info?.unifiedWindows;
  if (!w) return null;
  const win = (x) => (x && Number.isFinite(x.utilization)
    ? { used_percentage: x.utilization * 100, resets_at: x.resetsAt }
    : undefined);
  const five = win(w.five_hour);
  const week = win(w.seven_day);
  return five || week ? { five_hour: five, seven_day: week } : null;
}

/** A notice that doesn't come from Claude (process crashed, couldn't start, …). */
function addNotice(conv, tone, text, changed = []) {
  push(conv, { kind: 'notice', tone, text: String(text) }, changed);
  return changed;
}

module.exports = { createConversation, apply, addUser, addNotice, fromTranscript, rateLimits, settle };
