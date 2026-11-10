'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agents, buildArgs, cleanEnv, cleanTitle, findOnPath, findTranscript, forkTranscript, parseEnvProbe, projectDirName, validEffort, validModel } = require('../src/agent');

const FAKE = path.join(__dirname, '..', 'scripts', 'fake-claude.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-agent-'));
const ID = '2919bb5c-8956-4e8d-86ee-8ef004bb22db';
const OTHER = '7d3c2b1a-0f9e-4d8c-b7a6-112233445566';
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

/** A Claude Code transcript: two exchanges, entries carry uuid and sessionId like the real ones. */
function transcript(id, cwd) {
  const base = { sessionId: id, cwd, isSidechain: false, timestamp: '2026-11-10T10:00:00.000Z' };
  return [
    { type: 'queue-operation', operation: 'enqueue', sessionId: id },
    { ...base, type: 'user', uuid: 'u-1', parentUuid: null, message: { role: 'user', content: 'První otázka' } },
    { ...base, type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', message: { role: 'assistant', content: [{ type: 'text', text: 'První odpověď' }] } },
    { ...base, type: 'user', uuid: 'u-2', parentUuid: 'a-1', message: { role: 'user', content: 'Druhá otázka' } },
    { ...base, type: 'assistant', uuid: 'a-2', parentUuid: 'u-2', message: { role: 'assistant', content: [{ type: 'text', text: 'Druhá odpověď' }] } },
  ];
}

/** Resolves with the first event `name` whose payload passes `check`. */
const waitFor = (emitter, name, check = () => true) => new Promise((resolve) => {
  const on = (p) => {
    if (!check(p)) return;
    emitter.off(name, on);
    resolve(p);
  };
  emitter.on(name, on);
});
const waitState = (agents, check) => waitFor(agents, 'state', check);

/** Agents with the stand-in claude; every process is ended when the test is over (or node would wait for them). */
function agentsFor(t, dir, o = {}) {
  const agents = new Agents({ dir, port: 4799, bin: FAKE, projectsDir: path.join(dir, 'projects'), env: process.env, naming: false, ...o });
  t.after(() => agents.shutdown());
  return agents;
}

test('process arguments: a new session gets our id, a known one is resumed; model and effort when valid', () => {
  const common = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  assert.deepEqual(buildArgs({ id: ID, resume: false }), [...common, '--session-id', ID]);
  assert.deepEqual(buildArgs({ id: ID, resume: true }), [...common, '--resume', ID]);
  assert.deepEqual(buildArgs({ id: ID, resume: true, model: 'fable', effort: 'high' }), [...common, '--resume', ID, '--model', 'fable', '--effort', 'high']);
  assert.deepEqual(buildArgs({ id: ID, resume: false, model: 'claude-opus-5-5[1m]', effort: null }), [...common, '--session-id', ID, '--model', 'claude-opus-5-5[1m]']);
  assert.deepEqual(buildArgs({ id: ID, resume: false, model: 'gpt-5; rm -rf /', effort: 'turbo' }), [...common, '--session-id', ID]);
  assert.deepEqual(buildArgs({ id: ID, resume: false, model: '', effort: '' }), [...common, '--session-id', ID]);
  assert.equal(validModel('sonnet'), 'sonnet');
  assert.equal(validModel(''), null);
  assert.equal(validModel('--dangerously'), null);
  assert.equal(validEffort('max'), 'max');
  assert.equal(validEffort('extreme'), null);
});

test('environment: variables of a parent Claude session are dropped, the login shell is parsed', () => {
  assert.deepEqual(cleanEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
  const out = `Last login: today\n__AI_OFFICE_ENV__PATH=/opt/homebrew/bin:/bin\0HOME=/Users/x\0PWD=/tmp\0EMPTY=\0`;
  assert.deepEqual(parseEnvProbe(out), { PATH: '/opt/homebrew/bin:/bin', HOME: '/Users/x', EMPTY: '' });
  assert.equal(parseEnvProbe('no mark here'), null);
});

test('finding claude on PATH and transcripts under ~/.claude/projects', () => {
  const dir = tmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findOnPath('claude', `/nonexistent:${bin}`), path.join(bin, 'claude'));
  assert.equal(findOnPath('claude', '/nonexistent'), null);

  assert.equal(projectDirName('/Users/jenda/ai-office'), '-Users-jenda-ai-office');
  assert.equal(projectDirName('/Users/x/my_app.v2'), '-Users-x-my-app-v2');
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projects, 'other'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'other', `${ID}.jsonl`), '');
  assert.equal(findTranscript(projects, ID, '/Users/jenda/ai-office'), path.join(projects, 'other', `${ID}.jsonl`));
  assert.equal(findTranscript(projects, '../../etc/passwd', null), null);
  assert.equal(findTranscript(path.join(dir, 'missing'), ID, null), null);
});

test('forking a transcript: a copy under the new id, optionally cut before an entry', () => {
  const text = jsonl(transcript(ID, '/Users/x/proj'));
  const all = forkTranscript(text, ID, OTHER);
  assert.equal(all.length, 5);
  assert.ok(all.every((l) => !l.includes(ID)));
  assert.equal(JSON.parse(all[3]).sessionId, OTHER);
  assert.equal(JSON.parse(all[3]).uuid, 'u-2'); // entries keep their uuids, only the session changes

  const cut = forkTranscript(text, ID, OTHER, 'u-2');
  assert.deepEqual(cut.map((l) => JSON.parse(l).uuid ?? null), [null, 'u-1', 'a-1']);
  // nothing was said before the first message: no transcript at all (the copy starts afresh)
  assert.deepEqual(forkTranscript(text, ID, OTHER, 'u-1'), []);
  assert.deepEqual(forkTranscript('', ID, OTHER), []);
  // an unknown uuid copies everything; a torn last line (Claude is writing) is left out
  assert.equal(forkTranscript(`${text}{"type":"user","uuid":"u-`, ID, OTHER, 'nope').length, 5);
});

test('a session end to end with a stand-in claude: create, reply, cost, stop, dismiss, reload', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const agents = agentsFor(t, dir);
  const statuses = [];
  const turns = [];
  agents.on('status', (s) => statuses.push(s));
  agents.on('turn', (p) => turns.push(p.id));

  await assert.rejects(agents.create({ cwd: path.join(cwd, 'missing'), prompt: 'x' }), /Složka neexistuje/);

  const idle = waitState(agents, (s) => !s.busy && s.summary);
  const id = await agents.create({ cwd, prompt: 'Zkontroluj README' });
  const done = await idle;
  assert.equal(done.id, id);
  assert.equal(done.running, true);
  assert.equal(done.managed, true);
  assert.equal(done.title, 'Zkontroluj README');
  assert.equal(done.project, path.basename(cwd));
  assert.equal(done.liveModel, 'fake-model');
  assert.deepEqual(turns, [id]);
  const conv = await agents.open(id);
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'tool', 'text', 'done']);
  assert.equal(conv.items[1].status, 'ok');
  assert.match(conv.items[2].text, /Hotovo: \*\*Zkontroluj README\*\*/);
  assert.match(conv.items[2].text, /model výchozí, effort výchozí/);
  assert.ok(conv.seq > 0);
  assert.ok(statuses.some((s) => s.session_id === id && s.cost?.total_cost_usd === 0.01));
  assert.ok(statuses.some((s) => s.rate_limits?.five_hour?.used_percentage === 25));

  // interrupting a long turn keeps the session running
  const stopped = waitState(agents, (s) => !s.busy);
  await agents.send(id, 'slow task');
  assert.equal(agents.summary(id).busy, true);
  assert.equal(agents.stop(id), true);
  await stopped;
  assert.equal((await agents.open(id)).items.at(-1).error, 'přerušeno');
  assert.equal(agents.summary(id).running, true);

  const home = waitState(agents, (s) => !s.running);
  assert.equal(agents.dismiss(id), true);
  await home;
  assert.equal(agents.dismiss(id), false);
  agents.flush();

  // after a restart the session is known again; its conversation comes from the transcript
  const projects = path.join(dir, 'projects', projectDirName(cwd));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Zkontroluj README' } })}\n`);
  const again = agentsFor(t, dir);
  assert.equal(again.list()[0].id, id);
  assert.equal(again.list()[0].running, false);
  assert.deepEqual((await again.open(id)).items.map(({ kind, text }) => ({ kind, text })), [{ kind: 'user', text: 'Zkontroluj README' }]);
  assert.equal(await again.open('nope'), null);
});

test('model and effort: chosen at the start, changed later for the next process', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const agents = agentsFor(t, dir);

  const idle = waitState(agents, (s) => !s.busy && s.summary);
  const id = await agents.create({ cwd, prompt: 'Ahoj', model: 'sonnet', effort: 'high' });
  await idle;
  assert.equal(agents.summary(id).model, 'sonnet');
  assert.equal(agents.summary(id).effort, 'high');
  assert.match((await agents.open(id)).items.findLast((i) => i.kind === 'text').text, /model sonnet, effort high/);

  // an idle process ends right away; the next message starts one with the new flags
  const home = waitState(agents, (s) => s.id === id && !s.running);
  const s = agents.setOptions(id, { model: 'haiku', effort: '' });
  assert.equal(s.model, 'haiku');
  assert.equal(s.effort, null);
  await home;
  const replied = waitState(agents, (x) => x.id === id && !x.busy && x.running);
  await agents.send(id, 'Znovu');
  await replied;
  assert.match((await agents.open(id)).items.findLast((i) => i.kind === 'text').text, /model haiku, effort výchozí/);

  // options changed and a message sent straight away: the message waits for the new process instead of getting lost
  const replied2 = waitFor(agents, 'turn');
  agents.setOptions(id, { model: 'opus', effort: 'max' });
  await agents.send(id, 'Hned');
  await replied2;
  const items = (await agents.open(id)).items;
  assert.match(items.findLast((i) => i.kind === 'text').text, /Hotovo: \*\*Hned\*\*[\s\S]*model opus, effort max/);
  assert.equal(items.filter((i) => i.kind === 'notice').length, 0);

  assert.equal(agents.setOptions('nope', { model: 'opus' }), null);
  // an invalid model is the default, undefined leaves a setting as it is
  assert.equal(agents.setOptions(id, { model: 'gpt' }).model, null);
  assert.equal(agents.summary(id).effort, 'max');
});

test('a made-up title: without a label, wrapping quotes and a full stop, at most 80 characters', () => {
  assert.equal(cleanTitle('"Název: Oprav přihlašování"\n'), 'Oprav přihlašování');
  assert.equal(cleanTitle('Title: Fix the login.'), 'Fix the login');
  assert.equal(cleanTitle('název konverzace: „Oprava loginu“'), 'Oprava loginu');
  assert.equal(cleanTitle('**Název:** Oprava loginu'), 'Oprava loginu');
  assert.equal(cleanTitle('TITLE: Refaktor'), 'Refaktor');
  // a title that only starts like a label stays
  assert.equal(cleanTitle('Názvy proměnných v testech'), 'Názvy proměnných v testech');
  assert.equal(cleanTitle('Name-based routing'), 'Name-based routing');
  assert.equal(cleanTitle('Oprava: přihlášení'), 'Oprava: přihlášení');
  assert.equal(cleanTitle('„Proč to padá…“'), 'Proč to padá…');
  assert.equal(cleanTitle('x'.repeat(120)).length, 80);
  assert.equal(cleanTitle(' "" '), '');
});

test('a new session gets a name from a small model after its first turn', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const agents = agentsFor(t, dir, { naming: true });
  const turned = waitFor(agents, 'turn');
  const titled = waitFor(agents, 'title');
  const id = await agents.create({ cwd, prompt: 'Oprav přihlašování' });
  assert.deepEqual(await turned, { id });
  assert.deepEqual(await titled, { id, title: 'Oprav přihlašování' }); // the stand-in answers "Název: …" in quotes
  assert.equal(agents.meta.get(id).named, true);

  // named once: the next turn doesn't ask again
  let again = false;
  agents.on('title', () => { again = true; });
  const idle = waitState(agents, (s) => !s.busy && s.running);
  await agents.send(id, 'Ještě jednou');
  await idle;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(again, false);
});

test('fork: a full copy under a new id, with the original title', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const agents = agentsFor(t, dir);
  const idle = waitState(agents, (s) => !s.busy && s.summary);
  const id = await agents.create({ cwd, prompt: 'Původní', model: 'sonnet' });
  await idle;
  // the stand-in doesn't write transcripts – this is the one Claude would have written
  const folder = path.join(dir, 'projects', projectDirName(cwd));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), jsonl(transcript(id, cwd)));

  const forkId = await agents.fork({ id, before: null });
  assert.notEqual(forkId, id);
  const copy = fs.readFileSync(path.join(folder, `${forkId}.jsonl`), 'utf8');
  assert.ok(!copy.includes(id));
  assert.equal(copy.split('\n').filter(Boolean).length, 5);
  assert.ok(copy.includes(`"sessionId":"${forkId}"`));
  const s = agents.summary(forkId);
  assert.equal(s.forkOf, id);
  assert.equal(s.title, 'Původní');
  assert.equal(s.model, 'sonnet');
  assert.equal(s.running, false);
  assert.deepEqual((await agents.open(forkId)).items.filter((i) => i.kind === 'user').map((i) => i.text), ['První otázka', 'Druhá otázka']);

  // writing to the copy resumes it under its own id
  const replied = waitState(agents, (x) => x.id === forkId && !x.busy && x.running);
  await agents.send(forkId, 'Pokračuj');
  await replied;
  assert.match((await agents.open(forkId)).items.findLast((i) => i.kind === 'text').text, /Pokračuj[\s\S]*model sonnet/);

  // forgetting drops a session (after a rewind); its transcript stays
  const states = [];
  agents.on('state', (x) => states.push(x));
  assert.equal(agents.forget(id), true);
  assert.equal(agents.has(id), false);
  assert.equal(agents.forget(id), false);
  await new Promise((r) => setTimeout(r, 300)); // its process exits meanwhile
  assert.ok(states.every((x) => x && x.id !== id));
  assert.ok(fs.existsSync(path.join(folder, `${id}.jsonl`)));

  await assert.rejects(agents.fork({ id: OTHER, cwd: path.join(cwd, 'gone') }), /neexistuje/);
});

test('rewind: a copy cut before one of your messages (needs uuid on user items)', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const folder = path.join(dir, 'projects', projectDirName(cwd));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${OTHER}.jsonl`);
  fs.writeFileSync(file, jsonl(transcript(OTHER, cwd)));
  const agents = agentsFor(t, dir);

  const second = await agents.fork({ id: OTHER, cwd, file, before: 1 });
  const kept = fs.readFileSync(path.join(folder, `${second}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((e) => e.uuid ?? null), [null, 'u-1', 'a-1']);
  assert.ok(kept.every((e) => e.sessionId === second));
  assert.deepEqual((await agents.open(second)).items.map((i) => i.text), ['První otázka', 'První odpověď']);

  // before the very first message: an empty session in the same folder, no transcript yet
  const first = await agents.fork({ id: OTHER, cwd, file, before: 0 });
  assert.equal(fs.existsSync(path.join(folder, `${first}.jsonl`)), false);
  assert.equal(agents.summary(first).cwd, cwd);
  assert.deepEqual((await agents.open(first)).items, []);

  // past the last message: the whole conversation
  const all = await agents.fork({ id: OTHER, cwd, file, before: 9 });
  assert.equal(fs.readFileSync(path.join(folder, `${all}.jsonl`), 'utf8').split('\n').filter(Boolean).length, 5);
});

test('conversations of other apps open read-only from their transcript; only a few stay cached', async (t) => {
  const dir = tmp();
  const cwd = tmp();
  const folder = path.join(dir, 'projects', projectDirName(cwd));
  fs.mkdirSync(folder, { recursive: true });
  const agents = agentsFor(t, dir);
  const ids = Array.from({ length: 8 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);
  for (const id of ids) fs.writeFileSync(path.join(folder, `${id}.jsonl`), jsonl(transcript(id, cwd)));
  const fileOf = (id) => path.join(folder, `${id}.jsonl`);

  const conv = await agents.open(ids[0], { file: fileOf(ids[0]), cwd });
  assert.equal(conv.managed, false);
  assert.equal(conv.running, false);
  assert.equal(conv.cwd, cwd);
  assert.equal(conv.project, path.basename(cwd));
  assert.equal(conv.title, 'První otázka');
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'text', 'user', 'text']);
  assert.equal(agents.has(ids[0]), false);
  assert.equal(agents.list().length, 0);
  assert.equal(await agents.send(ids[0], 'ahoj'), false); // writing to it forks it first (main.js)
  assert.equal(agents.setOptions(ids[0], { model: 'opus' }), null);
  assert.equal(await agents.open(ids[1]), null); // without its transcript it isn't ours to open

  // continued elsewhere: read again
  assert.equal(conv.customTitle, '');
  fs.appendFileSync(fileOf(ids[0]), jsonl([
    { type: 'user', uuid: 'u-3', sessionId: ids[0], message: { role: 'user', content: 'Třetí' } },
    { type: 'ai-title', aiTitle: 'Tři otázky', sessionId: ids[0] }, // Claude Code's own name for it
  ]));
  const again = await agents.open(ids[0], { file: fileOf(ids[0]), cwd });
  assert.equal(again.items.length, 5);
  assert.equal(again.customTitle, 'Tři otázky');

  for (const id of ids.slice(1)) await agents.open(id, { file: fileOf(id), cwd });
  const cached = [...agents.live.keys()];
  assert.equal(cached.length, 6);
  assert.deepEqual(cached, ids.slice(2)); // the least recently opened went first

  // opening one again keeps it; sessions of ours are never evicted
  await agents.open(ids[2], { file: fileOf(ids[2]), cwd });
  const idle = waitState(agents, (s) => !s.busy && s.summary);
  const own = await agents.create({ cwd, prompt: 'Naše' });
  await idle;
  await agents.open(ids[0], { file: fileOf(ids[0]), cwd });
  assert.ok(agents.live.has(own));
  assert.ok(agents.live.has(ids[2]));
  assert.ok(!agents.live.has(ids[3]));
});

test('a claude that cannot start is reported in the conversation', async (t) => {
  const dir = tmp();
  const agents = agentsFor(t, dir, { bin: path.join(dir, 'no-such-claude'), projectsDir: dir });
  const failed = waitState(agents, (s) => !s.busy);
  const id = await agents.create({ cwd: dir, prompt: 'ahoj' });
  await failed;
  const last = (await agents.open(id)).items.at(-1);
  assert.equal(last.kind, 'notice');
  assert.match(last.text, /Nepodařilo se spustit claude/);
});
