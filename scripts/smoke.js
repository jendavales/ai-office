#!/usr/bin/env node
'use strict';
/**
 * Smoke test: starts the app on a spare port with an isolated profile, plays the demo,
 * forces the remaining states (idle chat, strike, night, stats panel) and fails when the
 * renderer logs an error. Leaves a screenshot for a visual check.
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const shot = process.env.AI_OFFICE_SCREENSHOT || path.join(os.tmpdir(), 'ai-office-smoke.png');
const root = path.join(__dirname, '..');
const evalCode = `(() => {
  const o = window.__office;
  // a conversation with the stand-in claude (scripts/fake-claude.js): new task, streamed reply, panel next to the office
  setTimeout(async () => {
    const id = await window.office.chat.create({ cwd: ${JSON.stringify(root)}, prompt: 'Zkontroluj README' });
    await o.openChat(id);
  }, 500);
  // runs 8 s after start (see main.js); delays below are relative to that
  setTimeout(() => {
    const free = [...o.workers.values()];
    if (free.length >= 2) new o.Convo(free[0], free[1], o.CHAT_PAIRS[0]);
  }, 4000);
  setTimeout(() => {
    // free for over 5 minutes → ghost
    const idle = [...o.workers.values()].find((w) => w.isFree);
    if (idle) idle.freeSince = performance.now() - 6 * 60e3;
  }, 1000);
  setTimeout(() => { o.state.forceHour = 22; }, 5000);
  setTimeout(() => { o.state.limits = { fiveHour: { used: 100, resetsAt: Date.now() + 3600e3 }, week: { used: 40 } }; }, 6000);
  setTimeout(() => o.openStats(), 9000);
  return 0;
})()`;

const electron = require('electron'); // path to the binary when required from node
const child = spawn(electron, ['.'], {
  cwd: root,
  env: {
    ...process.env,
    AI_OFFICE_CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'),
    AI_OFFICE_PORT: process.env.AI_OFFICE_PORT || '4798',
    AI_OFFICE_SCREENSHOT: shot,
    AI_OFFICE_SCREENSHOT_DELAY: '17500',
    AI_OFFICE_EVAL: evalCode,
  },
});

let errors = 0;
const onData = (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (line.includes('[renderer error]') || /Uncaught|ReferenceError|TypeError/.test(line)) {
      errors += 1;
      console.error(line);
    }
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => {
  if (errors || code) {
    console.error(`✖ smoke test failed (${errors} renderer errors, exit ${code})`);
    process.exit(1);
  }
  console.log(`✔ smoke test passed – screenshot: ${shot}`);
});
