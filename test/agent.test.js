'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agents, buildArgs, cleanEnv, findOnPath, findTranscript, parseEnvProbe, projectDirName } = require('../src/agent');

const FAKE = path.join(__dirname, '..', 'scripts', 'fake-claude.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-agent-'));
const ID = '2919bb5c-8956-4e8d-86ee-8ef004bb22db';

test('process arguments: a new session gets our id, a known one is resumed', () => {
  const common = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  assert.deepEqual(buildArgs({ id: ID, resume: false }), [...common, '--session-id', ID]);
  assert.deepEqual(buildArgs({ id: ID, resume: true }), [...common, '--resume', ID]);
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
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projects, 'other'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'other', `${ID}.jsonl`), '');
  assert.equal(findTranscript(projects, ID, '/Users/jenda/ai-office'), path.join(projects, 'other', `${ID}.jsonl`));
  assert.equal(findTranscript(projects, '../../etc/passwd', null), null);
  assert.equal(findTranscript(path.join(dir, 'missing'), ID, null), null);
});

/** Resolves with the first 'state' summary that passes `check`. */
const waitState = (agents, check) => new Promise((resolve) => {
  const on = (s) => {
    if (!check(s)) return;
    agents.off('state', on);
    resolve(s);
  };
  agents.on('state', on);
});

test('a session end to end with a stand-in claude: create, reply, cost, stop, dismiss, reload', async () => {
  const dir = tmp();
  const cwd = tmp();
  const agents = new Agents({ dir, port: 4799, bin: FAKE, projectsDir: path.join(dir, 'projects'), env: process.env });
  const statuses = [];
  agents.on('status', (s) => statuses.push(s));

  await assert.rejects(agents.create({ cwd: path.join(cwd, 'missing'), prompt: 'x' }), /Složka neexistuje/);

  const idle = waitState(agents, (s) => !s.busy && s.summary);
  const id = await agents.create({ cwd, prompt: 'Zkontroluj README' });
  const done = await idle;
  assert.equal(done.id, id);
  assert.equal(done.running, true);
  assert.equal(done.title, 'Zkontroluj README');
  assert.equal(done.project, path.basename(cwd));
  const conv = agents.open(id);
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'tool', 'text', 'done']);
  assert.equal(conv.items[1].status, 'ok');
  assert.match(conv.items[2].text, /Hotovo: \*\*Zkontroluj README\*\*/);
  assert.ok(statuses.some((s) => s.session_id === id && s.cost?.total_cost_usd === 0.01));
  assert.ok(statuses.some((s) => s.rate_limits?.five_hour?.used_percentage === 25));

  // interrupting a long turn keeps the session running
  const stopped = waitState(agents, (s) => !s.busy);
  await agents.send(id, 'slow task');
  assert.equal(agents.summary(id).busy, true);
  assert.equal(agents.stop(id), true);
  await stopped;
  assert.equal(agents.open(id).items.at(-1).error, 'přerušeno');
  assert.equal(agents.summary(id).running, true);

  const home = waitState(agents, (s) => !s.running);
  assert.equal(agents.dismiss(id), true);
  await home;
  agents.flush();

  // after a restart the session is known again; its conversation comes from the transcript
  const projects = path.join(dir, 'projects', projectDirName(cwd));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Zkontroluj README' } })}\n`);
  const again = new Agents({ dir, port: 4799, bin: FAKE, projectsDir: path.join(dir, 'projects'), env: process.env });
  assert.equal(again.list()[0].id, id);
  assert.deepEqual(again.open(id).items, [{ kind: 'user', text: 'Zkontroluj README' }]);
  assert.equal(again.open('nope'), null);
});

test('a claude that cannot start is reported in the conversation', async () => {
  const dir = tmp();
  const agents = new Agents({ dir, port: 4799, bin: path.join(dir, 'no-such-claude'), projectsDir: dir, env: process.env });
  const failed = waitState(agents, (s) => !s.busy);
  const id = await agents.create({ cwd: dir, prompt: 'ahoj' });
  await failed;
  const last = agents.open(id).items.at(-1);
  assert.equal(last.kind, 'notice');
  assert.match(last.text, /Nepodařilo se spustit claude/);
});
