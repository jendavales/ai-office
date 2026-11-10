'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanHistory, costOf } = require('../src/history');
const { Store } = require('../src/store');
const { projectRoot, sessionKey } = require('../src/hook-events');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

const prompt = (s, text, extra = {}) => ({ type: 'user', uuid: `u${s}`, timestamp: at(s), message: { role: 'user', content: text }, ...extra });
const toolResult = (s, id) => ({ type: 'user', uuid: `r${s}`, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } });
const reply = (s, id, stop, content, extra = {}) => ({
  type: 'assistant', uuid: `a${s}`, timestamp: at(s), ...extra,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', stop_reason: stop, usage, content },
});
const toolUse = (id, name) => ({ type: 'tool_use', id, name, input: {} });

function write(file, entries, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify({ sessionId: meta.sessionId, cwd: meta.cwd, ...e })).join('\n'));
}

/** Two projects, a resumed copy, a subagent in a worktree, a temp-folder run and a turn after the cutoff. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-history-'));
  const shop = { sessionId: 's1', cwd: '/w/eshop' };
  const finished = [
    prompt(0, 'Přidej kupóny'),
    reply(10, 'm1', 'tool_use', [{ type: 'thinking', thinking: '' }]),
    reply(10, 'm1', 'tool_use', [toolUse('t1', 'Bash'), toolUse('t2', 'Agent')]),
    toolResult(20, 't1'),
    reply(60, 'm2', 'end_turn', [{ type: 'text', text: 'Hotovo' }]),
  ];
  write(path.join(root, '-w-eshop', 's1.jsonl'), [
    ...finished,
    prompt(100, '<command-name>/model</command-name>'), // local command, no reply: must not start the clock
    prompt(200, 'Oprav test'),
    reply(205, 'm3', 'tool_use', [toolUse('t3', 'Edit')]),
    prompt(230, '[Request interrupted by user]'), // interrupted: time counts, task does not
    prompt(1000, 'Po uzávěrce', { uuid: 'late' }),
    reply(1010, 'm4', 'end_turn', [toolUse('t4', 'Read')]),
  ], shop);
  // resumed session repeating the same history → counted once
  write(path.join(root, '-w-eshop', 's2.jsonl'), finished, { sessionId: 's2', cwd: '/w/eshop' });
  // subagent of s1 running in a worktree → belongs to the eshop employee, never a finished task
  write(path.join(root, '-w-eshop', 's1', 'subagents', 'agent-x.jsonl'), [
    reply(30, 'm5', 'end_turn', [toolUse('t5', 'Grep')], { isSidechain: true }),
  ], { sessionId: 's1', cwd: '/w/eshop/.claude/worktrees/abc' });
  // a session started in a worktree belongs to the repository
  write(path.join(root, '-w-api--claude-worktrees-x', 's3.jsonl'), [
    prompt(0, 'Ahoj'),
    reply(5, 'm6', 'end_turn', [{ type: 'text', text: 'Ahoj' }]),
  ], { sessionId: 's3', cwd: '/w/api/.claude/worktrees/x' });
  // scripted run in a temp folder → skipped
  write(path.join(root, '-private-tmp-run', 's4.jsonl'), [
    prompt(0, 'test'),
    reply(5, 'm7', 'end_turn', [toolUse('t7', 'Bash')]),
  ], { sessionId: 's4', cwd: '/private/tmp/run' });
  return root;
}

test('cost follows the API price list', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } };
  assert.ok(Math.abs(costOf('claude-opus-5-5', u) - (4 + 20 + 0.2 + 5 + 8)) < 1e-9); // 5 min and 1 h writes priced apart
  assert.equal(costOf('claude-haiku-4-5-20251001', { output_tokens: 1e6 }), 5);
  assert.equal(costOf('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 200_000 }), 0.1);
  assert.equal(costOf('<synthetic>', u), null);
});

test('projectRoot folds worktrees and scratch chats into one project', () => {
  assert.equal(projectRoot('/w/eshop/.claude/worktrees/abc/src'), '/w/eshop');
  assert.equal(projectRoot('/w/eshop/.worktrees/RY-625'), '/w/eshop');
  assert.equal(projectRoot('/w/eshop/src'), '/w/eshop/src');
  assert.equal(projectRoot('/u/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'), '/u/Library/Application Support/Claude/scratch-workspaces');
  assert.equal(sessionKey({ sessionId: 'x', source: 'Claude', cwd: '/w/api/.claude/worktrees/x' }), '/w/api');
});

test('history: tools, finished turns, working time and cost per project', async () => {
  const h = await scanHistory({ root: fixture(), until: T0 + 500_000 });
  assert.deepEqual(Object.keys(h.projects).sort(), ['/w/api', '/w/eshop']);
  assert.equal(h.skipped, 1);
  const shop = h.projects['/w/eshop'];
  // tools t1 t2 t3 + subagent t5 (t4 is after the cutoff); one finished task (m2), the copy in s2 counted once
  assert.deepEqual([shop.tools, shop.done, shop.xp], [4, 1, 4 + 10]);
  // finished turn 0 → 60 s, interrupted turn 200 → 205 s; the /model command did not start the clock
  assert.equal(shop.workMs, 65_000);
  assert.equal(shop.since, T0);
  assert.equal(shop.label, 'eshop');
  assert.ok(Math.abs(shop.cost - 4 * costOf('claude-opus-5-5', usage)) < 1e-12); // m1 m2 m3 m5, each once
  const day = h.days['2026-10-01']['/w/eshop'];
  assert.deepEqual(day.tools, { terminal: 1, agents: 1, editing: 1, reading: 1 });
  assert.equal(day.done, 1);
  assert.deepEqual([h.projects['/w/api'].done, h.projects['/w/api'].label], [1, 'api']);
});

test('history: everything after the cutoff is left to live tracking', async () => {
  const h = await scanHistory({ root: fixture(), until: T0 });
  assert.deepEqual(h.projects, {});
});

test('import merges into existing project careers once and keeps a backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
  const store = new Store(dir);
  const live = store.profile('/w/eshop', 'eshop');
  store.recordDone('/w/eshop', 1000);
  store.profile('ai:Codex', 'Codex').since = 1; // other AIs and demo don't move the cutoff
  store.flush();
  assert.equal(store.liveSince(), live.since);

  const h = await scanHistory({ root: fixture(), until: T0 + 500_000 });
  store.importHistory(h);
  assert.equal(store.data.profiles['/w/eshop'], live); // same career, history added on top
  const shop = store.publicProfile('/w/eshop');
  assert.deepEqual([shop.label, shop.xp, shop.done], ['eshop', 10 + 14, 2]);
  assert.equal(store.data.profiles['/w/eshop'].since, T0);
  assert.ok(store.publicProfile('/w/api'));
  assert.equal(store.data.history.until, T0 + 500_000);
  assert.ok(fs.existsSync(path.join(dir, 'office-data.json.bak-before-history')));

  const reloaded = new Store(dir);
  assert.equal(reloaded.data.history.projects, 2);
  assert.equal(reloaded.publicProfile('/w/eshop').xp, 24);
});
