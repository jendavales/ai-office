'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { addUser, apply, createConversation, fromTranscript, rateLimits, settle } = require('../src/stream-events');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

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
  assert.deepEqual(conv.items[1], { kind: 'tool', toolId: 't1', name: 'Read', label: 'sid.txt', status: 'run', input: '/x/sid.txt', output: null });
  assert.deepEqual(apply(conv, toolResult('t1')), [1]);
  assert.equal(conv.items[1].status, 'ok');
  assert.equal(conv.items[1].output, null); // a file's contents are for Claude, not shown

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
  // a slash command is a message of yours (shown as "/clear", as in Claude desktop), thinking is shown too
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'user', 'thinking', 'text', 'tool', 'notice']);
  assert.equal(conv.items[1].text, '/clear');
  assert.equal(conv.title, 'Reply with just the word: alpha');
  assert.equal(conv.items[4].status, 'stop');
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

// --- shown the way Claude desktop shows a conversation -----------------------------------------------------------

// fixtures: real record shapes, shortened and anonymized. desktop-transcript.jsonl follows a Claude desktop session
// (2.1.321), stream-skill.jsonl is recorded `claude -p … stream-json` output of a Skill call (2.1.314).
const userMsg = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

test('a desktop transcript: only what you wrote and what Claude did', () => {
  const conv = fromTranscript(fixture('desktop-transcript.jsonl'));
  const view = conv.items.map((i) => (i.kind === 'tool' ? `tool ${i.name} ${i.label}` : `${i.kind} ${i.text}`));
  assert.deepEqual(view, [
    'user Je tohle repo bezpečné?',
    'thinking Projdu kód a zjistím, kam aplikace posílá data.',
    'tool Skill claude-api', // the skill's contents (a meta message) aren't shown
    'tool Bash git ls-files | head -3',
    'tool Read main.js',
    'user A posílá něco na internet?', // sent while Claude worked: a queued_command attachment
    'text Nic neposílá data ven.', // hooks, reminders, a peer agent's message: nothing
    'user Co je na obrázku?',
    'text Je tam diagram.',
    'user Přišla mi odpověď:\n\nDobrý den,\n\nuživatele založíme zítra.\n\nCo na to říkáš?',
    'tool Bash npm test',
    'text Testy běží na pozadí.',
    'notice Background command "npm test" completed (exit code 0)', // and no synthetic "No response requested."
    'user /compact', // before its result, as it happened
    'notice Kontext zkomprimován', // not the summary, the caveat or the command output
    "notice Opus 5.5's safeguards stopped the response above · continuing once with that noted",
    'user /work-report Report za úterý', // a skill run as a slash command; its contents hidden, subagent too
    "notice You've hit your monthly spend limit. Switch to another model to continue.",
    'notice Přerušeno.',
    'user Díky', // the history the desktop app wrote again is skipped
  ]);
  assert.equal(conv.items[17].tone, 'error');
  assert.deepEqual(conv.items[7], { kind: 'user', text: 'Co je na obrázku?', uuid: conv.items[7].uuid, images: 1 });
  assert.equal(conv.title, 'Je tohle repo bezpečné?');
  assert.equal(conv.customTitle, 'Bezpečnost repozitáře'); // the last one counts
  assert.equal(conv.agentName, 'Bezpečnost repa');
  assert.equal(conv.aiTitle, 'Kontrola bezpečnosti repozitáře');
});

test('your messages carry the uuid of their transcript entry, in order, the same on every read', () => {
  const text = fixture('desktop-transcript.jsonl');
  const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const users = fromTranscript(text).items.filter((i) => i.kind === 'user');
  assert.ok(users.every((u) => u.uuid));
  // each uuid points at the entry holding that message (fork cuts the transcript there), in transcript order
  const lineOf = users.map((u) => entries.findIndex((e) => e.uuid === u.uuid));
  assert.deepEqual([...lineOf].sort((a, b) => a - b), lineOf);
  assert.equal(entries[lineOf[1]].attachment.prompt, 'A posílá něco na internet?');
  // /compact starts where its compaction does, so a rewind to before it gets the uncompacted conversation back
  assert.equal(entries[lineOf[4]].subtype, 'compact_boundary');
  assert.match(entries[lineOf[4] + 3].message.content, /<command-name>\/compact/);
  assert.deepEqual(fromTranscript(text).items, fromTranscript(text).items);
});

test('a Skill call streamed live: the skill name, never its contents', () => {
  const conv = createConversation();
  addUser(conv, 'Call the Skill tool with skill "claude-api", then reply with one word: done.');
  for (const line of fixture('stream-skill.jsonl').split('\n').filter(Boolean)) apply(conv, JSON.parse(line));
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'tool', 'text', 'done']);
  const tool = conv.items[1];
  assert.deepEqual([tool.name, tool.label, tool.status, tool.input, tool.output], ['Skill', 'claude-api', 'ok', 'claude-api', null]);
  // thinking shown only as "updates" (empty) leaves nothing behind
  assert.deepEqual(conv.items[2], { kind: 'text', text: 'done', done: true });
  assert.equal(conv.model, 'claude-haiku-5-5');
});

test('system reminders go, the rest of the message stays', () => {
  const conv = createConversation();
  apply(conv, userMsg('Oprav <system-reminder>\nThe user opened the file a.js in the IDE.\n</system-reminder> ten test', { uuid: 'u1' }));
  apply(conv, userMsg('<system-reminder>\nThe session "x" you started finished a turn.\n</system-reminder>'));
  apply(conv, userMsg('<system-reminder>\nLinked sessions now: none.\n</system-reminder>\n\nBackground (from the session that started this one):\nGoal: deploy'));
  assert.deepEqual(conv.items, [
    { kind: 'user', text: 'Oprav ten test', uuid: 'u1' },
    { kind: 'user', text: 'Background (from the session that started this one):\nGoal: deploy' },
  ]);
});

test('slash commands, command output and other wrappers', () => {
  const conv = createConversation();
  apply(conv, userMsg('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-5-5</command-args>'));
  apply(conv, userMsg('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'));
  apply(conv, userMsg('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'));
  apply(conv, userMsg('<bash-input>git status</bash-input>'));
  apply(conv, userMsg('<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>'));
  apply(conv, userMsg('<some-new-wrapper>written by Claude Code</some-new-wrapper>'));
  addUser(conv, '<div>proč se tohle nevykreslí?</div>'); // your own HTML stays
  assert.deepEqual(conv.items.map((i) => i.text), ['/model claude-opus-5-5', '! git status', '<div>proč se tohle nevykreslí?</div>']);
  assert.equal(conv.title, '/model claude-opus-5-5');
});

test('pasted content without its tags; very long blocks and messages shortened', () => {
  const conv = createConversation();
  const log = Array.from({ length: 200 }, (_, i) => `řádek ${i} logu`).join('\n');
  apply(conv, userMsg(`Co je tohle?\n\n<pasted_content id="b214">\n${log}\n</pasted_content id="b214">`));
  const item = conv.items[0];
  assert.equal(item.truncated, true);
  assert.ok(item.text.startsWith('Co je tohle?\n\nřádek 0 logu\n'));
  assert.ok(item.text.length <= 'Co je tohle?\n\n'.length + 1500);
  assert.ok(item.text.endsWith('…'));
  assert.doesNotMatch(item.text, /pasted_content/);
  addUser(conv, 'x'.repeat(30_000));
  assert.equal(conv.items[1].text.length, 10_000);
  assert.equal(conv.items[1].truncated, true);
});

test('tool calls: a readable input, the start of the output', () => {
  const conv = createConversation();
  apply(conv, toolUse('e1', 'Edit', { file_path: '/r/a.js', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 3;' }));
  apply(conv, toolUse('w1', 'Write', { file_path: '/r/b.md', content: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') }));
  apply(conv, toolUse('g1', 'Grep', { pattern: 'TODO', path: 'src', glob: '*.js' }));
  apply(conv, toolUse('a1', 'Agent', { description: 'Najdi testy', subagent_type: 'Explore', prompt: 'Find the tests.' }));
  apply(conv, toolUse('t1', 'TodoWrite', { todos: [{ content: 'Napsat test', status: 'completed' }, { content: 'Lint', status: 'in_progress' }] }));
  apply(conv, toolUse('m1', 'mcp__a318f781-f523-492a-b8d5-3428256e8b21__getJiraIssue', { cloudId: 'x.atlassian.net', issueIdOrKey: 'AB-1' }));
  apply(conv, toolUse('b1', 'Bash', { command: `echo ${'y'.repeat(1000)}` }));
  apply(conv, toolUse('r1', 'Read', { file_path: '/r/missing.txt' }));
  apply(conv, toolUse('f1', 'WebFetch', { url: 'https://example.com', prompt: 'Summarize' }));
  const [edit, write, grep, agent, todo, mcp, bash, read, fetch] = conv.items;
  assert.equal(edit.input, '/r/a.js\n- const a = 1;\n- const b = 2;\n+ const a = 3;');
  assert.equal(write.input.split('\n').length, 10); // path, 8 lines, …
  assert.equal(grep.input, 'TODO\npath: src\nglob: *.js');
  assert.equal(agent.input, '[Explore] Najdi testy\n\nFind the tests.');
  assert.equal(todo.input, '☑ Napsat test\n◐ Lint');
  assert.equal(mcp.label, 'getJiraIssue'); // a connector's server id says nothing
  assert.equal(mcp.input, 'cloudId: x.atlassian.net\nissueIdOrKey: AB-1');
  assert.equal(bash.input.length, 600);

  apply(conv, toolResult('b1', { content: [{ type: 'text', text: `${'z'.repeat(2000)}` }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }));
  apply(conv, toolResult('g1', { content: 'src/a.js:3: // TODO\n<system-reminder>\nnote for Claude\n</system-reminder>' }));
  apply(conv, toolResult('r1', { content: '<tool_use_error>File does not exist.</tool_use_error>', is_error: true }));
  apply(conv, toolResult('f1', { content: '# Example Domain\nThis domain is for use in examples.' }));
  assert.equal(bash.output.length, 800);
  assert.ok(bash.output.endsWith('…'));
  assert.equal(grep.output, 'src/a.js:3: // TODO');
  assert.deepEqual([read.status, read.output], ['err', 'File does not exist.']); // a content tool's error is shown
  assert.equal(fetch.output, null); // the page itself isn't
  assert.equal(edit.output, null); // no result yet
});

test('thinking: streamed, replaced by the complete block, shortened', () => {
  const conv = createConversation();
  apply(conv, ev({ type: 'message_start' }));
  apply(conv, ev({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }));
  apply(conv, ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } })); // nothing to show yet
  assert.equal(conv.items.length, 0);
  apply(conv, ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Nejdřív ' } }));
  const changed = apply(conv, ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'testy.' } }));
  assert.deepEqual(changed, [0]);
  assert.deepEqual(conv.items[0], { kind: 'thinking', text: 'Nejdřív testy.', done: false });
  apply(conv, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'Nejdřív testy, pak lint.' }] } });
  assert.deepEqual(conv.items[0], { kind: 'thinking', text: 'Nejdřív testy, pak lint.', done: true });

  apply(conv, ev({ type: 'message_start' }));
  for (let i = 0; i < 50; i++) apply(conv, ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(100) } }));
  assert.equal(conv.items[1].text.length, 2000);
  settle(conv, []);
  assert.equal(conv.items[1].done, true);

  apply(conv, { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'y'.repeat(5000) }] } });
  assert.equal(conv.items[2].text.length, 2000);
  assert.ok(conv.items[2].text.endsWith('…'));
});

test('compaction live: one notice for the boundary and the summary', () => {
  const conv = createConversation();
  addUser(conv, '/compact');
  apply(conv, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1000 } });
  apply(conv, userMsg('This session is being continued from a previous conversation that ran out of context. Summary: …'));
  apply(conv, { type: 'system', subtype: 'informational', content: 'Compacted using a summary written while you were away', level: 'notice' });
  assert.deepEqual(conv.items.map((i) => i.text), ['/compact', 'Kontext zkomprimován']);
});

test('messages Claude Code adds for itself are skipped live too', () => {
  const conv = createConversation();
  apply(conv, userMsg([{ type: 'text', text: 'Base directory for this skill: /x' }], { isSynthetic: true }));
  apply(conv, userMsg('Your response above was cut off mid-stream. Resume directly from where it stops.', { isMeta: true }));
  apply(conv, userMsg('Ahoj', { isReplay: true })); // your own message echoed back – already added when sending
  apply(conv, { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'Sleep for 6 seconds' });
  apply(conv, { type: 'assistant', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } });
  assert.deepEqual(conv.items, []);
  apply(conv, { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  assert.deepEqual(conv.items, [{ kind: 'notice', tone: 'error', text: 'Not logged in · Please run /login' }]);
});

test('background task notifications are one line', () => {
  const conv = createConversation();
  const note = (status, summary) => `<task-notification>\n<task-id>a1</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<result>long report…</result>\n</task-notification>`;
  apply(conv, userMsg(note('completed', 'Agent &quot;Review&quot; finished'), { origin: { kind: 'task-notification' } }));
  apply(conv, { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: note('failed', 'Background command "npm test" failed with exit code 1') } });
  assert.deepEqual(conv.items, [
    { kind: 'notice', tone: 'info', text: 'Agent "Review" finished' },
    { kind: 'notice', tone: 'warn', text: 'Background command "npm test" failed with exit code 1' },
  ]);
  assert.equal(conv.title, '');
});

test('a message from another Claude session is a line, not yours', () => {
  const conv = createConversation();
  apply(conv, userMsg('<system-reminder>\nLinked sessions now: none.\n</system-reminder>\n\n<cross-session-message from="local_1" name="Deploy na server">\nThe user approved the push.\n</cross-session-message>', { promptSource: 'sdk' }));
  assert.deepEqual(conv.items, [{ kind: 'notice', tone: 'info', text: 'Zpráva od „Deploy na server“: The user approved the push.' }]);
});
