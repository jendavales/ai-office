/** Statistics panel (today / last 7 days / everyone ever, per employee), employee and project of the week. */
import { TOOL_CZ } from '../content/texts.js';
import { state } from '../state.js';
import { tooltip } from './tooltip.js';

export const statsEl = document.getElementById('stats');

export let statsTab = 'today';

export let statsData = null;


export function el(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content != null) node.textContent = content;
  return node;
}


export const fmtMinutes = (ms) => {
  if (ms > 0 && ms < 60_000) return '< 1 min';
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};


export async function refreshStats() {
  if (!window.office?.stats) return;
  try {
    statsData = await window.office.stats();
    state.employeeOfWeek = statsData.employeeOfWeek;
    state.projectOfWeek = statsData.projectOfWeek;
  } catch { /* main process not ready */ }
  if (!statsEl.hidden) renderStats();
}


export function openStats() {
  statsEl.hidden = false;
  tooltip.hidden = true;
  renderStats();
  refreshStats();
}


export function closeStats() {
  statsEl.hidden = true;
}


export function renderStats() {
  const panel = el('div', 'panel');
  const head = el('div', 'head');
  head.append(el('h2', null, '📊 Statistiky kanceláře'));
  const close = el('button', 'close', '✕');
  close.addEventListener('click', closeStats);
  head.append(close);
  panel.append(head);

  const tabs = el('div', 'tabs');
  for (const [key, label] of [['today', 'Dnes'], ['week', 'Posledních 7 dní'], ['total', 'Celkem']]) {
    const b = el('button', key === statsTab ? 'active' : '', label);
    b.addEventListener('click', () => {
      statsTab = key;
      renderStats();
    });
    tabs.append(b);
  }
  panel.append(tabs);

  const eow = statsData?.employeeOfWeek;
  const pow = statsData?.projectOfWeek;
  const team = (n) => (n > 1 ? `, tým ${n} ${n < 5 ? 'lidé' : 'lidí'}` : '');
  const award = el('div', 'award');
  award.textContent = eow
    ? `★ Zaměstnanec týdne: ${eow.name} (${eow.label}) – ${eow.title}, hotové úkoly: ${eow.done}`
      + (pow ? ` · Projekt týdne: ${pow.label} – ${pow.done} úkolů${team(pow.people)}` : '')
    : '★ Zaměstnanec týdne: zatím nikdo – první dokončený úkol rozhodne.';
  panel.append(award);

  const rows = statsData?.[statsTab] ?? [];
  if (!rows.length) {
    panel.append(el('p', 'empty', statsData ? 'Zatím žádná data.' : 'Načítám…'));
  } else {
    const table = el('table');
    const thead = el('tr');
    for (const h of ['Zaměstnanec', 'Projekt', 'Úkoly', 'Odpracováno', 'Výplata', 'Nejčastěji']) thead.append(el('th', null, h));
    table.append(thead);
    let total = { done: 0, workMs: 0, cost: 0 };
    for (const r of rows) {
      total = { done: total.done + r.done, workMs: total.workMs + r.workMs, cost: total.cost + r.cost };
      const tr = el('tr');
      if (r.since) tr.title = `ve firmě od ${new Date(r.since).toLocaleDateString('cs-CZ')}`;
      const who = el('td');
      who.append(el('b', null, r.name ?? '?'), el('span', 'title', ` ${r.title ?? ''}`));
      if (r.nextXp) {
        const bar = el('div', 'xp');
        const fill = el('div');
        fill.style.width = `${Math.round(((r.xp - r.levelXp) / (r.nextXp - r.levelXp)) * 100)}%`;
        bar.append(fill);
        bar.title = `${r.xp} / ${r.nextXp} XP`;
        who.append(bar);
      }
      tr.append(who, el('td', null, r.label ?? ''), el('td', 'num', String(r.done)), el('td', 'num', fmtMinutes(r.workMs)),
        el('td', 'num', r.cost ? `$${r.cost.toFixed(2)}` : '–'));
      const top = Object.entries(r.tools).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([cat, n]) => `${TOOL_CZ[cat] ?? cat} ${n}`).join(' · ');
      tr.append(el('td', 'tools', top || '–'));
      table.append(tr);
    }
    const sum = el('tr', 'sum');
    sum.append(el('td', null, 'Celkem'), el('td'), el('td', 'num', String(total.done)), el('td', 'num', fmtMinutes(total.workMs)),
      el('td', 'num', total.cost ? `$${total.cost.toFixed(2)}` : '–'), el('td'));
    table.append(sum);
    panel.append(table);
  }
  if (statsTab === 'total') panel.append(el('p', 'hint', 'Všichni zaměstnanci za celou dobu, včetně historie konverzací. Najetím na řádek uvidíš, odkdy jsou ve firmě.'));
  panel.append(el('p', 'hint', 'XP: +1 za každý nástroj, +10 za hotový úkol · Junior → Medior (150) → Senior (600) → Lead (1500) → Ředitel (4000)'));
  statsEl.replaceChildren(panel);
}


statsEl.addEventListener('click', (e) => {
  if (e.target === statsEl) closeStats();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeStats();
});
