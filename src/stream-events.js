'use strict';
/**
 * One conversation as a list of items, built from Claude Code's stream-json output
 * (`claude -p --output-format stream-json`) or from a saved transcript (~/.claude/projects/…/<id>.jsonl).
 * Both use the same message shapes, so a conversation reloaded after a restart looks like a live one.
 * Pure logic (unit-tested). Unknown message types are ignored: the format grows between Claude Code versions.
 *
 * Items:
 *   { kind: 'user', text }                       – your message
 *   { kind: 'text', text, done }                 – Claude's reply (markdown), streamed while done = false
 *   { kind: 'tool', toolId, name, label, status } – a tool call, status run | ok | err | stop
 *   { kind: 'notice', tone, text }               – something worth knowing (tone info | warn | error)
 *   { kind: 'done', ms, cost, error }            – end of a turn
 */
const { describeTool, oneLine } = require('./hook-events');

function createConversation() {
  return { items: [], busy: false, activity: '', title: '', summary: '', model: null, mode: null, live: -1, tools: {} };
}

function push(conv, item, changed) {
  conv.items.push(item);
  changed.push(conv.items.length - 1);
  return conv.items.length - 1;
}

// whole message wrapped in one tag: slash-command echoes, local command output, reminders – not something you wrote
const WRAPPED = /^<([a-z][\w-]*)>[\s\S]*<\/\1>\s*$/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

/** Your own message. Live messages aren't echoed back by Claude Code, so the caller adds them when sending. */
function addUser(conv, text, changed = []) {
  const t = String(text ?? '').trim();
  if (!t || WRAPPED.test(t)) return changed;
  if (INTERRUPTED.test(t)) {
    push(conv, { kind: 'notice', tone: 'info', text: 'Přerušeno.' }, changed);
    return changed;
  }
  conv.title ||= oneLine(t, 60);
  push(conv, { kind: 'user', text: t }, changed);
  return changed;
}

function toolLabel(name, input) {
  if (name === 'Agent' || name === 'Task') return oneLine(input.description || input.subagent_type || 'subagent', 60);
  return describeTool(name, input);
}

function streamEvent(conv, ev, changed) {
  if (!ev) return;
  if (ev.type === 'message_start') {
    conv.busy = true;
  } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
    conv.live = push(conv, { kind: 'text', text: '', done: false }, changed);
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && conv.live >= 0) {
    conv.items[conv.live].text += ev.delta.text ?? '';
    changed.push(conv.live);
  }
}

function assistant(conv, message, changed) {
  for (const block of message?.content ?? []) {
    if (block?.type === 'text') {
      const live = conv.live >= 0 ? conv.items[conv.live] : null;
      if (live && !live.done) {
        live.text = block.text ?? live.text; // the complete block replaces the streamed deltas
        live.done = true;
        changed.push(conv.live);
        conv.live = -1;
      } else if (block.text?.trim()) {
        push(conv, { kind: 'text', text: block.text, done: true }, changed);
      }
    } else if (block?.type === 'tool_use') {
      const item = { kind: 'tool', toolId: block.id, name: block.name, label: toolLabel(block.name, block.input ?? {}), status: 'run' };
      conv.tools[block.id] = push(conv, item, changed);
    }
  }
}

function user(conv, message, changed) {
  const content = message?.content;
  if (typeof content === 'string') {
    addUser(conv, content, changed);
    return;
  }
  if (!Array.isArray(content)) return;
  const texts = [];
  for (const block of content) {
    if (block?.type === 'tool_result') {
      const idx = conv.tools[block.tool_use_id];
      if (idx == null) continue;
      conv.items[idx].status = block.is_error ? 'err' : 'ok';
      changed.push(idx);
    } else if (block?.type === 'text') {
      texts.push(block.text);
    }
  }
  if (texts.length) addUser(conv, texts.join('\n'), changed);
}

function system(conv, msg) {
  if (msg.subtype === 'init') {
    conv.model = msg.model ?? conv.model;
    conv.mode = msg.permissionMode ?? conv.mode;
  } else if (msg.subtype === 'task_summary') conv.activity = msg.detail ? oneLine(msg.detail, 80) : '';
  else if (msg.subtype === 'post_turn_summary') conv.summary = oneLine(msg.status_detail, 120);
}

function errorText(msg) {
  if (msg.subtype === 'error_during_execution') return 'přerušeno';
  return oneLine(typeof msg.result === 'string' && msg.result ? msg.result : msg.subtype || 'chyba', 200);
}

/** Tools left running when a turn ends (interrupt, crash) didn't finish. */
function settle(conv, changed) {
  if (conv.live >= 0) {
    conv.items[conv.live].done = true;
    changed.push(conv.live);
    conv.live = -1;
  }
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

/** Applies one stream-json message or transcript entry; returns indices of the items it added or changed. */
function apply(conv, msg) {
  const changed = [];
  if (!msg || typeof msg !== 'object') return changed;
  // subagent internals and meta entries (command output, reminders) aren't part of the conversation
  if (msg.parent_tool_use_id || msg.isSidechain || msg.isMeta) return changed;
  switch (msg.type) {
    case 'stream_event': streamEvent(conv, msg.event, changed); break;
    case 'assistant': assistant(conv, msg.message, changed); break;
    case 'user': user(conv, msg.message, changed); break;
    case 'system': system(conv, msg); break;
    case 'result': result(conv, msg, changed); break;
    default: break;
  }
  return [...new Set(changed)];
}

/** Conversation from a saved transcript (JSONL text). Nothing is running, so whatever was open is settled. */
function fromTranscript(text) {
  const conv = createConversation();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      apply(conv, JSON.parse(line));
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
