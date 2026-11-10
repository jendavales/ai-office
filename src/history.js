'use strict';
/**
 * History import: reads past Claude Code conversations (~/.claude/projects/<project>/*.jsonl, like ccusage)
 * and turns them into the numbers the live hooks would have produced:
 *  - every tool call = +1 XP (subagent calls included, as PreToolUse fires for them too)
 *  - every finished turn (assistant stop_reason end_turn, i.e. the Stop hook) = +10 XP and one task done
 *  - working time from the prompt to the end of the turn, API-equivalent cost from token usage
 * Read-only and fully local. Ids (tool_use, message, entry) are de-duplicated across files, so resumed
 * sessions that repeat earlier history are counted once. Only entries before `until` are counted.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { basename, projectRoot, toolCategory } = require('./hook-events');
const { XP_DONE, XP_TOOL, dayKey } = require('./store');

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_TURN_MS = 12 * 3_600_000; // same sanity limit as Store.recordWork
const END_REASONS = new Set(['end_turn', 'stop_sequence', 'refusal']);

// USD per million tokens: [input, output, cache write 5 min, cache write 1 h, cache read] (Anthropic API list prices)
const PRICES = {
  'claude-fable-5-2': [8, 40, 10, 16, 0.2],
  'claude-mythos-5-2': [8, 40, 10, 16, 0.2],
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-fable-5': [10, 50, 12.5, 20, 1],
  'claude-mythos-5': [10, 50, 12.5, 20, 1],
  'claude-opus-5-5': [4, 20, 5, 8, 0.2],
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
  'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
};
const HAIKU_55_LONG = [0.5, 2.5, 0.625, 1, 0.05]; // Claude Haiku 5.5 prompts over 100K tokens

/** API-equivalent price of one response in USD, or null for a model without a known price. */
function costOf(model, usage) {
  const id = String(model ?? '').replace(/\[.*$/, '').replace(/-\d{8}$/, '');
  const u = usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const price = id === 'claude-haiku-5-5' && input + read + write > 100_000 ? HAIKU_55_LONG : PRICES[id];
  if (!price) return null;
  const [pIn, pOut, pWrite5m, pWrite1h, pRead] = price;
  const fast = u.speed === 'fast' ? 2 : 1; // fast mode is billed at 2x on every model that has it
  return (fast * (input * pIn + output * pOut + (write - write1h) * pWrite5m + write1h * pWrite1h + read * pRead)) / 1e6;
}

const TEMP_DIRS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', `${os.tmpdir()}/`];
/** Throwaway sessions (scripted `claude -p` runs in temp folders) would only add noise employees. */
const isTemp = (cwd) => TEMP_DIRS.some((dir) => `${cwd}/`.startsWith(dir));

/** Session transcripts first (they define each session's project), subagent transcripts after. */
async function listTranscripts(root) {
  const sessions = [];
  const subagents = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) (depth === 1 && !e.name.startsWith('agent-') ? sessions : subagents).push(p);
    }
  }
  await walk(root, 0);
  return { sessions, subagents };
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.find((b) => b?.type === 'text')?.text ?? '' : '';
};

/**
 * @param {{ root?: string, until?: number, onProgress?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<{ until: number, projects: Record<string, object>, days: Record<string, Record<string, object>>,
 *   files: number, sessions: number, skipped: number, unknownModels: Record<string, number> }>}
 */
async function scanHistory({ root = DEFAULT_ROOT, until = Date.now(), onProgress } = {}) {
  const ctx = {
    until,
    seen: new Set(), // ids already counted (tool_use, message, turn) – resumed sessions repeat history
    sessionKeys: new Map(), // sessionId -> project key (null = skipped)
    projects: new Map(),
    days: {},
    sessions: 0,
    skipped: 0,
    unknownModels: {},
  };
  const { sessions, subagents } = await listTranscripts(root);
  const files = [...sessions, ...subagents];
  for (let i = 0; i < files.length; i++) {
    await scanFile(files[i], i < sessions.length, ctx);
    onProgress?.(i + 1, files.length);
  }
  return {
    until,
    // projects seen only after `until` are left to live tracking
    projects: Object.fromEntries([...ctx.projects].filter(([, p]) => Number.isFinite(p.since))),
    days: ctx.days,
    files: files.length,
    sessions: ctx.sessions,
    skipped: ctx.skipped,
    unknownModels: ctx.unknownModels,
  };
}

async function scanFile(file, isSession, ctx) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let key; // project of this transcript; null = skipped
  let proj = null;
  let turn = null; // { start, last, id, answered } – the main conversation's current turn
  const responses = new Map(); // message id -> { model, usage, ts } (one response is logged as several lines)

  const day = (ts) => {
    const d = dayKey(new Date(ts));
    ctx.days[d] ??= {};
    return (ctx.days[d][key] ??= { done: 0, tools: {}, workMs: 0, cost: 0 });
  };
  const addWork = (ts, ms) => {
    if (ms <= 0 || ms >= MAX_TURN_MS) return;
    day(ts).workMs += ms;
    proj.workMs += ms;
  };
  const once = (id) => {
    if (ctx.seen.has(id)) return false;
    ctx.seen.add(id);
    return true;
  };
  /** A turn that ended without a reply (interrupted, API error, new prompt): its time still counts. */
  const closeTurn = () => {
    if (turn?.answered && turn.last < ctx.until && once(`work:${turn.id}`)) addWork(turn.last, turn.last - turn.start);
    turn = null;
  };

  try {
    for await (const line of rl) {
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== 'assistant' && e.type !== 'user') continue;
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts)) continue;

      if (key === undefined) {
        if (e.isSidechain && ctx.sessionKeys.has(e.sessionId)) key = ctx.sessionKeys.get(e.sessionId);
        else if (e.cwd) key = isTemp(e.cwd) ? null : projectRoot(e.cwd);
        else continue;
        if (isSession && e.sessionId) ctx.sessionKeys.set(e.sessionId, key);
        if (key === null) {
          if (isSession) ctx.skipped += 1;
          return;
        }
        proj = ctx.projects.get(key);
        if (!proj) {
          proj = { label: basename(key), since: Infinity, sessions: 0, done: 0, tools: 0, xp: 0, workMs: 0, cost: 0 };
          ctx.projects.set(key, proj);
        }
        if (isSession) {
          proj.sessions += 1;
          ctx.sessions += 1;
        }
      }
      if (ts < ctx.until) proj.since = Math.min(proj.since, ts);

      const msg = e.message;
      if (e.type === 'assistant') {
        if (!msg || msg.model === '<synthetic>') continue; // local error notices, not model output
        if (msg.id && msg.usage) {
          const prev = responses.get(msg.id);
          if (!prev || (msg.usage.output_tokens ?? 0) > (prev.usage.output_tokens ?? 0)) {
            responses.set(msg.id, { model: msg.model, usage: msg.usage, ts: prev?.ts ?? ts });
          }
        }
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block?.type !== 'tool_use' || !block.id || !block.name || ts >= ctx.until || !once(`tool:${block.id}`)) continue;
          const cat = toolCategory(block.name);
          const d = day(ts);
          d.tools[cat] = (d.tools[cat] ?? 0) + 1;
          proj.tools += 1;
          proj.xp += XP_TOOL;
        }
        if (e.isSidechain) continue;
        turn ??= { start: ts, last: ts, id: e.uuid ?? msg.id, answered: false };
        turn.last = Math.max(turn.last, ts);
        turn.answered = true;
        if (END_REASONS.has(msg.stop_reason)) {
          if (ts < ctx.until && once(`done:${msg.id ?? e.uuid}`)) {
            day(ts).done += 1;
            proj.done += 1;
            proj.xp += XP_DONE;
            addWork(ts, ts - turn.start);
          }
          turn = null;
        }
        continue;
      }

      // user entries of the main conversation: prompts start a turn, tool results extend it
      if (e.isSidechain || e.isMeta) continue;
      const content = msg?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
        if (turn) turn.last = Math.max(turn.last, ts);
        continue;
      }
      if (!textOf(content)) continue;
      if (turn?.answered) closeTurn();
      turn = { start: ts, last: ts, id: e.uuid, answered: false }; // the latest prompt before the reply starts the clock
    }
    closeTurn();
  } finally {
    rl.close();
    input.destroy();
  }

  for (const [id, r] of responses) {
    if (r.ts >= ctx.until || !once(`msg:${id}`)) continue;
    const usd = costOf(r.model, r.usage);
    if (usd == null) {
      ctx.unknownModels[r.model] = (ctx.unknownModels[r.model] ?? 0) + 1;
      continue;
    }
    day(r.ts).cost += usd;
    proj.cost += usd;
  }
}

module.exports = { scanHistory, costOf, isTemp, DEFAULT_ROOT };
