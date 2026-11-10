'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Conversations, promptText, readTranscript, sourceOf } = require('../src/conversations');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-conv-'));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const user = (text, extra = {}) => ({ type: 'user', timestamp: '2026-11-10T10:00:00.000Z', cwd: '/Users/x/proj', entrypoint: 'claude-desktop', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const assistant = (text, extra = {}, model = undefined) => ({ type: 'assistant', timestamp: '2026-11-10T10:01:00.000Z', cwd: '/Users/x/proj', isSidechain: false, message: { role: 'assistant', model, stop_reason: 'end_turn', content: [{ type: 'text', text }] }, ...extra });
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

function write(root, dir, id, lines) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, `${id}.jsonl`), typeof lines === 'string' ? lines : jsonl(lines));
}

test('prompt text: your words without reminders, command echoes and tool results', () => {
  assert.equal(promptText('Ahoj\n<system-reminder>meta</system-reminder> světe'), 'Ahoj\n světe');
  assert.equal(promptText([{ type: 'text', text: 'blok' }, { type: 'image', source: {} }]), 'blok');
  assert.equal(promptText([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), '');
  assert.equal(promptText('<command-name>/clear</command-name>'), '');
  assert.equal(promptText('<local-command-stdout>ok</local-command-stdout>'), '');
  assert.equal(promptText('[Request interrupted by user]'), '');
  assert.equal(promptText(''), '');
  assert.equal(sourceOf('claude-desktop'), 'desktop');
  assert.equal(sourceOf('sdk-cli'), 'sdk');
  assert.equal(sourceOf('cli'), 'cli');
  assert.equal(sourceOf(undefined), 'cli');
});

test('a transcript is read into its summary, torn lines and subagents aside', async () => {
  const root = tmp();
  write(root, '-Users-x-proj', A, `${jsonl([
    { type: 'queue-operation', operation: 'enqueue' },
    user('Udělej review'),
    user('tool', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
    user('meta', { isMeta: true }),
    assistant('Hotovo', { timestamp: '2026-11-10T10:05:00.000Z' }, 'claude-fable-5-1'),
    assistant('subagent', { isSidechain: true, timestamp: '2026-11-11T10:05:00.000Z' }, 'claude-haiku-4-5'),
    { type: 'agent-name', agentName: 'Review projektu', sessionId: A },
    { type: 'custom-title', customTitle: 'Review PR 12', sessionId: A },
    { type: 'ai-title', aiTitle: 'Review kódu', sessionId: A },
    user('A ještě testy', { timestamp: '2026-11-10T10:06:00.000Z' }),
    { type: 'assistant', isSidechain: false, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
  ])}{"type":"user","mess`);
  const info = await readTranscript(path.join(root, '-Users-x-proj', `${A}.jsonl`));
  assert.equal(info.cwd, '/Users/x/proj');
  assert.equal(info.entrypoint, 'claude-desktop');
  assert.deepEqual(info.prompts, ['Udělej review', 'A ještě testy']);
  assert.equal(info.firstPrompt, 'Udělej review');
  assert.equal(info.customTitle, 'Review PR 12');
  assert.equal(info.agentName, 'Review projektu');
  assert.equal(info.aiTitle, 'Review kódu');
  assert.equal(info.model, 'claude-fable-5-1'); // of the last reply – not a subagent's, not a synthetic one
  assert.equal(info.turns, 1);
  assert.equal(info.createdAt, Date.parse('2026-11-10T10:00:00.000Z'));
  assert.equal(info.lastActive, Date.parse('2026-11-10T10:06:00.000Z'));
});

test('a Claude desktop transcript: its titles and the model it answered with', async () => {
  const info = await readTranscript(path.join(__dirname, 'fixtures', 'desktop-transcript.jsonl'));
  assert.equal(info.customTitle, 'Bezpečnost repozitáře'); // the last one counts
  assert.equal(info.agentName, 'Bezpečnost repa');
  assert.equal(info.aiTitle, 'Kontrola bezpečnosti repozitáře');
  assert.equal(info.model, 'claude-opus-5-5'); // the spend-limit note after it is <synthetic>
  assert.equal(info.firstPrompt, 'Je tohle repo bezpečné?');
});

test('titles: yours, then Claude\'s own (custom-title, agent-name, ai-title), then ours; the last model in the summary', async () => {
  const dir = tmp();
  const root = path.join(dir, 'projects');
  write(root, '-Users-x-proj', A, [
    user('Oprav chybu'), assistant('Opraveno', {}, 'claude-opus-5-5'),
    { type: 'ai-title', aiTitle: 'Oprava chyby', sessionId: A },
    { type: 'agent-name', agentName: 'Opravář', sessionId: A },
  ]);
  write(root, '-Users-x-proj', B, [user('Napiš testy'), { type: 'ai-title', aiTitle: 'Testy košíku', sessionId: B }]);
  write(root, '-Users-x-proj', C, [user('Bez názvu zatím'), assistant('Ok')]);
  const conv = new Conversations({ dir, projectsDir: root });
  await conv.scan();
  conv.setAuto(A, 'Náš název');
  conv.setAuto(B, 'Náš název');
  conv.setAuto(C, 'Náš název');
  assert.equal(conv.titleOf(A), 'Opravář'); // agent-name beats ai-title
  assert.equal(conv.titleOf(B), 'Testy košíku'); // ai-title beats ours
  assert.equal(conv.titleOf(C), 'Náš název');
  conv.rename(B, 'Můj název');
  assert.equal(conv.get(B).title, 'Můj název');
  assert.equal(conv.get(A).lastModel, 'claude-opus-5-5');
  assert.equal(conv.get(B).lastModel, null); // no reply yet
  assert.equal(conv.get(C).lastModel, null); // a reply without a model
  conv.flush();

  // a cache of an older version: transcripts are read again, your titles stay
  const file = path.join(dir, 'conversations.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const info of Object.values(data.files)) delete info.aiTitle;
  fs.writeFileSync(file, JSON.stringify({ ...data, version: 1 }));
  const again = new Conversations({ dir, projectsDir: root });
  assert.equal(again.get(A), null);
  assert.equal(again.titleOf(B), 'Můj název');
  await again.scan();
  assert.equal(again.titleOf(A), 'Opravář');
  assert.equal(again.get(A).lastModel, 'claude-opus-5-5');
});

test('the index: scan, titles, search, rename, archive, hide, cache', async () => {
  const dir = tmp();
  const root = path.join(dir, 'projects');
  write(root, '-Users-x-proj', A, [user('Oprav chybu v přihlášení'), assistant('Opraveno'), { type: 'custom-title', customTitle: 'Oprava loginu', sessionId: A }]);
  write(root, '-Users-x-proj', B, [user('Napiš testy pro košík', { entrypoint: 'cli', timestamp: '2026-11-09T10:00:00.000Z' })]);
  write(root, '-private-tmp-x', C, [user('scratch', { cwd: '/private/tmp/x' })]);
  write(root, '-Users-x-proj', 'not-a-session', [user('ignored')]);
  fs.mkdirSync(path.join(root, '-Users-x-proj', A), { recursive: true });
  write(root, path.join('-Users-x-proj', A), 'agent-abc', [user('subagent file, deeper')]);

  const conv = new Conversations({ dir, projectsDir: root });
  const updates = [];
  conv.on('update', () => updates.push(1));
  await conv.scan();
  assert.ok(updates.length >= 1);
  const list = conv.list();
  assert.deepEqual(list.map((s) => s.id), [A, B]); // most recent first, temp folders and odd files skipped
  assert.equal(list[0].title, 'Oprava loginu');
  assert.equal(list[0].source, 'desktop');
  assert.equal(list[0].project, 'proj');
  assert.equal(list[0].projectPath, '/Users/x/proj');
  assert.equal(list[1].title, 'Napiš testy pro košík');
  assert.equal(list[1].source, 'cli');
  assert.equal(conv.fileOf(A), path.join(root, '-Users-x-proj', `${A}.jsonl`));

  // search: every word, diacritics-insensitive, with a snippet from the prompt
  assert.deepEqual(conv.search('kosik testy').map((h) => h.id), [B]);
  assert.match(conv.search('prihlaseni')[0].snippet, /přihlášení/);
  assert.equal(conv.search('login')[0].snippet, ''); // matched the title itself
  assert.deepEqual(conv.search('  '), []);
  assert.deepEqual(conv.search('PROJ').map((h) => h.id), [A, B]); // the project matches too, most recent first

  conv.rename(B, 'Testy košíku');
  assert.equal(conv.get(B).title, 'Testy košíku');
  conv.rename(B, '');
  assert.equal(conv.get(B).title, 'Napiš testy pro košík');
  conv.setAuto(B, 'Košík: testy');
  assert.equal(conv.titleOf(B), 'Košík: testy');
  assert.equal(conv.titleOf(A), 'Oprava loginu'); // Claude's own title beats ours
  conv.archive(A);
  assert.equal(conv.list().find((s) => s.id === A).archived, true);
  conv.archive(A, false);
  assert.equal(conv.list().find((s) => s.id === A).archived, false);
  conv.hide(A);
  assert.deepEqual(conv.list().map((s) => s.id), [B]);
  assert.deepEqual(conv.search('login'), []);
  conv.flush();

  // a second instance starts from the cache and re-reads only what changed
  const again = new Conversations({ dir, projectsDir: root });
  assert.equal(again.list()[0].title, 'Košík: testy');
  assert.equal(again.isHidden(A), true);
  fs.appendFileSync(path.join(root, '-Users-x-proj', `${B}.jsonl`), jsonl([user('A ještě dokumentaci', { timestamp: '2026-11-12T10:00:00.000Z' })]));
  fs.rmSync(path.join(root, '-Users-x-proj', `${A}.jsonl`));
  await again.scan();
  assert.deepEqual(again.list().map((s) => s.id), [B]);
  assert.equal(again.get(B).lastActive, Date.parse('2026-11-12T10:00:00.000Z'));
  assert.deepEqual(again.search('dokumentaci').map((h) => h.id), [B]);
  assert.equal(again.get(A), null);
  assert.equal(await again.touch(B), false); // unchanged since the scan
});

test('a session that just got its transcript is indexed on touch; updates are announced', async () => {
  const dir = tmp();
  const root = path.join(dir, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const conv = new Conversations({ dir, projectsDir: root });
  await conv.scan();
  assert.deepEqual(conv.list(), []);
  assert.equal(await conv.touch(A), false); // no transcript yet
  assert.equal(conv.titleOf(A), null);

  let updates = 0;
  conv.on('update', () => { updates += 1; });
  write(root, '-Users-x-proj', A, [user('Nová session', { entrypoint: 'sdk-cli' }), assistant('Ok')]);
  assert.equal(await conv.touch(A), true);
  assert.equal(updates, 1);
  assert.equal(conv.get(A).source, 'sdk');
  assert.equal(conv.get(A).turns, 1);
  assert.equal(conv.get(A).title, 'Nová session');
  conv.setAuto(A, '  ');
  assert.equal(conv.titleOf(A), null); // an empty name is no name
  conv.setAuto(A, 'Pojmenováno');
  assert.equal(conv.get(A).title, 'Pojmenováno');
  assert.equal(conv.isArchived(A), false);
  conv.archive(A, true);
  assert.equal(conv.isArchived(A), true);
  assert.equal(updates, 3);
  conv.stop();
});
