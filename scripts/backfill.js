#!/usr/bin/env node
'use strict';
/**
 * Preview of the history import (read-only): what AI Office adds from past Claude Code conversations
 * on its next start. The import itself runs once inside the app; this script never writes anything.
 *   npm run backfill            preview against the app's data (cutoff = start of live tracking)
 *   AI_OFFICE_DATA_DIR=… / CLAUDE_PROJECTS_DIR=…   other locations
 */
const os = require('node:os');
const path = require('node:path');
const { scanHistory, DEFAULT_ROOT } = require('../src/history');
const { Store, XP_DONE } = require('../src/store');

const dataDir = process.env.AI_OFFICE_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'ai-office');
const root = process.env.CLAUDE_PROJECTS_DIR || DEFAULT_ROOT;
const store = new Store(dataDir); // only read – nothing here calls save()/flush()

const fmtDate = (ts) => new Date(ts).toLocaleString('cs-CZ');
const hours = (ms) => `${(ms / 3_600_000).toFixed(1)} h`;
const usd = (n) => `$${n.toFixed(2)}`;

async function main() {
  if (store.data.history) {
    console.log(`Historie už je naimportovaná (${fmtDate(store.data.history.importedAt)}, ${store.data.history.sessions} sessions do ${fmtDate(store.data.history.until)}).`);
    console.log('Níže je jen pro kontrolu, co by import obsahoval.\n');
  }
  const until = store.data.history?.until ?? store.liveSince();
  const started = Date.now();
  const h = await scanHistory({
    root,
    until,
    onProgress: (done, total) => process.stderr.isTTY && process.stderr.write(`\rčtu ${done}/${total} souborů…`),
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

  const rows = Object.entries(h.projects).sort(([, a], [, b]) => b.xp - a.xp);
  const table = [['projekt', 'sessions', 'úkoly', 'nástroje', 'XP', 'čas', 'výplata', 'od'],
    ...rows.map(([, p]) => [p.label, p.sessions, p.done, p.tools, p.xp, hours(p.workMs), usd(p.cost), new Date(p.since).toLocaleDateString('cs-CZ')])];
  const sum = (f) => rows.reduce((acc, [, p]) => acc + p[f], 0);
  table.push(['CELKEM', sum('sessions'), sum('done'), sum('tools'), sum('xp'), hours(sum('workMs')), usd(sum('cost')), '']);
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const [i, r] of table.entries()) {
    console.log(r.map((c, j) => (j === 0 ? String(c).padEnd(widths[j]) : String(c).padStart(widths[j]))).join('  '));
    if (i === 0 || i === table.length - 2) console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  }
  console.log(`\nZdroj: ${root} (${h.files} souborů, ${h.sessions} sessions), načteno za ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`Započítáno vše před ${fmtDate(until)} – od té chvíle počítají živé hooky.`);
  if (h.skipped) console.log(`Přeskočeno ${h.skipped} sessions z dočasných složek (skriptované běhy v /tmp).`);
  const unknown = Object.entries(h.unknownModels);
  if (unknown.length) console.log(`Bez ceny (neznámý model): ${unknown.map(([m, n]) => `${m} ×${n}`).join(', ')}`);
  console.log(`XP: +1 za nástroj, +${XP_DONE} za hotový úkol. Výplata = cena tokenů podle ceníku API (jako ccusage).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
