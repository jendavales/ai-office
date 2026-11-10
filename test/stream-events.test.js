'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addUser, apply, createConversation, fromTranscript, rateLimits } = require('../src/stream-events');

// shapes as recorded from `claude -p --output-format stream-json --verbose --include-partial-messages` (2.1.x)
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const toolUse = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, extra = {}) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...extra }] } });
const text = (t) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3708, total_cost_usd: 0.0037, permission_denials: [], ...extra });

test('a streamed turn: tool call, streamed text, end of turn', () => {
  const conv = createConversation();
  addUser(conv, 'Přečti sid.txt');
  assert.equal(conv.title, 'Přečti sid.txt');

  apply(conv, { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', permissionMode: 'auto' });
  apply(conv, ev({ type: 'message_start' }));
  assert.equal(conv.busy, true);
  apply(conv, toolUse('t1', 'Read', { file_path: '/x/sid.txt' }));
  apply(conv, { type: 'system', subtype: 'task_summary', detail: 'Reading sid.txt' });
  assert.equal(conv.activity, 'Reading sid.txt');
  assert.deepEqual(conv.items[1], { kind: 'tool', toolId: 't1', name: 'Read', label: 'sid.txt', status: 'run' });
  assert.deepEqual(apply(conv, toolResult('t1')), [1]);
  assert.equal(conv.items[1].status, 'ok');

  apply(conv, ev({ type: 'content_block_start', content_block: { type: 'text' } }));
  apply(conv, ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'The file ' } }));
  const changed = apply(conv, ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'holds' } }));
  assert.deepEqual(changed, [2]);
  assert.deepEqual(conv.items[2], { kind: 'text', text: 'The file holds', done: false });
  // the complete block arrives before content_block_stop and replaces the deltas
  apply(conv, text('The file holds **an id**.'));
  apply(conv, ev({ type: 'content_block_stop' }));
  assert.deepEqual(conv.items[2], { kind: 'text', text: 'The file holds **an id**.', done: true });
  assert.equal(conv.items.length, 3);

  apply(conv, { type: 'system', subtype: 'post_turn_summary', status_detail: 'sid.txt holds a single session ID' });
  apply(conv, result());
  assert.equal(conv.busy, false);
  assert.equal(conv.activity, '');
  assert.equal(conv.summary, 'sid.txt holds a single session ID');
  assert.equal(conv.model, 'claude-haiku-5-5');
  assert.equal(conv.mode, 'auto');
  assert.deepEqual(conv.items[3], { kind: 'done', ms: 3708, cost: 0.0037, error: null });
});

test('a text block without streaming (no partial messages) is added whole', () => {
  const conv = createConversation();
  apply(conv, text('alpha'));
  assert.deepEqual(conv.items, [{ kind: 'text', text: 'alpha', done: true }]);
});

test('subagent messages, failed tools and permission denials', () => {
  const conv = createConversation();
  apply(conv, toolUse('a1', 'Agent', { description: 'Prozkoumat repo', subagent_type: 'Explore' }));
  assert.equal(conv.items[0].label, 'Prozkoumat repo');
  // the subagent's own work belongs to it, not to this conversation
  assert.deepEqual(apply(conv, { ...text('inside the subagent'), parent_tool_use_id: 'a1' }), []);
  apply(conv, toolUse('b1', 'Bash', { command: 'rm -rf build' }));
  apply(conv, toolResult('b1', { is_error: true }));
  assert.equal(conv.items[1].status, 'err');
  apply(conv, result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b1' }] }));
  assert.equal(conv.items[0].status, 'stop'); // never finished
  assert.deepEqual(conv.items[2], { kind: 'notice', tone: 'warn', text: 'Zamítnuto – nástroj potřeboval povolení: Bash' });
});

test('interrupted and failed turns', () => {
  const conv = createConversation();
  apply(conv, ev({ type: 'content_block_start', content_block: { type: 'text' } }));
  apply(conv, ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Office cats' } }));
  apply(conv, { type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.equal(conv.items[0].done, true);
  assert.equal(conv.items[1].error, 'přerušeno');
  apply(conv, result({ subtype: 'error', is_error: true, result: 'API Error: 529 overloaded' }));
  assert.equal(conv.items[2].error, 'API Error: 529 overloaded');
});

test('unknown and malformed messages are ignored', () => {
  const conv = createConversation();
  for (const msg of [null, 'x', {}, { type: 'something_new' }, { type: 'system', subtype: 'hook_started' }, { type: 'stream_event' }]) {
    assert.deepEqual(apply(conv, msg), []);
  }
  assert.equal(conv.items.length, 0);
});

test('a transcript reloads into the same items', () => {
  const lines = [
    { type: 'queue-operation' },
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Reply with just the word: alpha' } },
    { type: 'attachment' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'alpha' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'sleep 100' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ];
  const conv = fromTranscript(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"user","mess`);
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'text', 'tool', 'notice']);
  assert.equal(conv.title, 'Reply with just the word: alpha');
  assert.equal(conv.items[2].status, 'stop');
  assert.equal(conv.busy, false);
});

test('rate limit events in the status-line shape', () => {
  const info = { unifiedWindows: { five_hour: { utilization: 0.16, resetsAt: 1794328800 }, seven_day: { utilization: 0.67, resetsAt: 1794463200 } } };
  assert.deepEqual(rateLimits({ type: 'rate_limit_event', rate_limit_info: info }), {
    five_hour: { used_percentage: 16, resets_at: 1794328800 },
    seven_day: { used_percentage: 67, resets_at: 1794463200 },
  });
  assert.equal(rateLimits({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null);
});
