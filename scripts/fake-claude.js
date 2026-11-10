#!/usr/bin/env node
'use strict';
/**
 * Stand-in for `claude -p --input-format stream-json --output-format stream-json` in tests and the smoke run
 * (AI_OFFICE_CLAUDE_BIN=scripts/fake-claude.js): answers every message with a streamed reply and one Read call,
 * honours interrupts, no network, no tokens. Message shapes follow recorded Claude Code 2.1 output.
 * A message containing "slow" keeps working until interrupted.
 */
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1] || 'fake';
const out = (msg) => process.stdout.write(`${JSON.stringify({ session_id: id, ...msg })}\n`);
let turn = 0;
let working = null;

function finish(subtype, extra = {}) {
  clearTimeout(working);
  working = null;
  out({ type: 'system', subtype: 'post_turn_summary', status_category: 'completed', status_detail: `odpověď ${turn}` });
  out({ type: 'result', subtype, is_error: subtype !== 'success', duration_ms: 1200, total_cost_usd: 0.01 * turn, result: 'ok', permission_denials: [], ...extra });
}

function answer(text) {
  turn += 1;
  out({ type: 'system', subtype: 'init', model: 'fake-model', permissionMode: 'auto', cwd: process.cwd() });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${turn}a`, content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: { file_path: `${process.cwd()}/README.md` } }] } });
  out({ type: 'system', subtype: 'task_summary', detail: 'Reading README.md' });
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: '1\t# AI Office' }] } });
  if (/slow/.test(text)) {
    working = setTimeout(() => finish('success'), 60_000);
    return;
  }
  const reply = `Hotovo: **${text.slice(0, 40)}**\n\n- bod jedna\n- bod dva`;
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } });
  for (const part of reply.match(/.{1,8}/gs)) out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${turn}b`, content: [{ type: 'text', text: reply }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1794328800 }, seven_day: { utilization: 0.5, resetsAt: 1794463200 } } } });
  finish('success');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      if (working) finish('error_during_execution', { result: undefined });
    } else if (msg.type === 'user') {
      answer(String(msg.message?.content ?? ''));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
