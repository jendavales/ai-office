/** Hover tooltips, hit testing and click handling on the canvas. */
import { ACTIVITY_CZ, DIRECTOR_CZ, IDLE_CZ } from '../content/texts.js';
import { COMPACT, canvas, toLogical } from '../core/canvas.js';
import { isManaged, openChat } from '../chat/store.js';
import { catHit, petCat } from '../life/cat.js';
import { state, workers } from '../state.js';
import { openStats } from './stats.js';
import { director } from '../entities/director.js';
import { EMOTIONS } from '../entities/mood.js';
import { openTodos } from '../todo/store.js';
import { TASK_BOARD } from '../world/layout.js';

export const tooltip = document.getElementById('tooltip');


export function hitTest(lx, ly) {
  const hit = (p, k = 1) => lx >= p.x - 7 * k && lx <= p.x + 7 * k && ly >= p.y - 26 * k && ly <= p.y + 6;
  for (const w of workers.values()) {
    if (w.gone) continue;
    for (const i of w.interns) if (hit(i, 0.8)) return { intern: i };
    if (hit(w)) return { worker: w };
  }
  if (hit(director)) return { director: true };
  const b = TASK_BOARD;
  if (lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) return { taskBoard: true };
  if (catHit(lx, ly)) return { cat: true };
  if (lx >= 70 && lx <= 110 && ly >= 7 && ly <= 34) return { board: true };
  if (lx >= 4 && lx <= 24 && ly >= 6 && ly <= 32) return { portrait: true };
  return null;
}


const pct = (v) => Math.round(((v + 1) / 2) * 100);

function moodLine(w) {
  const m = w.mood;
  return `nálada: ${EMOTIONS[m.current].icon ?? '🙂'} ${EMOTIONS[m.current].label} · pohoda ${pct(m.valence)} % · energie ${pct(m.energy)} %`;
}

export function workerInfo(w) {
  const interns = w.interns.filter((i) => !i.leaving).length + w.extraInterns;
  const p = w.profile;
  const state = w.ghost ? '👻 duch – přes 5 min bez práce, terminál je otevřený'
    : w.waiting ? 'čeká na povolení'
    : w.place === 'board' || w.place === 'toBoard' ? 'porada u tabule (plan mód)'
      : w.idle ? `pauza – ${IDLE_CZ[w.idle.kind]}` : ACTIVITY_CZ[w.activity] ?? w.activity;
  const xp = p ? `${p.title} · ${p.xp} XP${p.nextXp ? ` (další úroveň ${p.nextXp})` : ''} · hotovo celkem ${p.done}` : '';
  return [
    w.name ? `${w.name} – ${w.project}  (${w.source})` : `${w.project}  (${w.source})`,
    w.coverFor ? `zastupuje ${w.coverFor.whom ?? w.coverFor.name} (vlastník konverzace)` : '',
    xp,
    w.cwd,
    `stav: ${state}`,
    moodLine(w),
    w.context != null ? `kontext: ${w.context} %${w.cost != null ? ` · výplata: $${w.cost.toFixed(2)}` : ''}` : '',
    w.lastText ? `poslední: ${w.lastText}` : '',
    interns ? `stážisti: ${interns}` : '',
    window.office ? (isManaged(w.id) ? '🖱 klik = otevřít konverzaci' : '🖱 klik = přepnout do terminálu') : '',
  ].filter(Boolean).join('\n');
}


/** The to-do counts, any Todoist error and what a click does – shared by the director and the task board. */
function todoLines() {
  const { configured, overdue, today, week, total, error } = director.todos;
  return [
    configured ? `${overdue} po termínu · ${today} na dnes · ${week} do týdne · ${total} celkem` : 'Todoist zatím není napojený',
    error ? `⚠️ ${error}` : '',
    '🖱 klik = úkoly a nastavení',
  ];
}

function directorInfo() {
  return [
    'Ředitel – to jsi ty. Hlídá úkoly z Todoistu.',
    `stav: ${DIRECTOR_CZ[director.beat?.kind ?? 'idle']}`,
    ...todoLines(),
  ].filter(Boolean).join('\n');
}

const taskBoardInfo = () => [
  'Nástěnka ředitele – lísteček za každý úkol z Todoistu: červený po termínu, žlutý na dnes, zelený do týdne.',
  ...todoLines(),
].filter(Boolean).join('\n');


canvas.addEventListener('mousemove', (e) => {
  const found = hitTest(...toLogical(e));
  canvas.style.cursor = found ? 'pointer' : 'default';
  if (!found) {
    tooltip.hidden = true;
    return;
  }
  let info;
  if (found.worker) info = workerInfo(found.worker);
  else if (found.director) info = directorInfo();
  else if (found.taskBoard) info = taskBoardInfo();
  else if (found.intern) info = `stážista (subagent)\n${found.intern.label}\nšéf: ${found.intern.boss.displayName}\n🖱 klik = přepnout do terminálu`;
  else if (found.cat) info = 'Bajt – kancelářská kočka\n🖱 klik = pohladit';
  else if (found.portrait) info = state.employeeOfWeek ? `Zaměstnanec týdne: ${state.employeeOfWeek.name} (${state.employeeOfWeek.label}, ${state.employeeOfWeek.title})\n${state.employeeOfWeek.done} hotových úkolů za 7 dní\n🖱 klik = statistiky` : 'Zaměstnanec týdne – zatím nikdo\n🖱 klik = statistiky';
  else info = '🖱 klik = statistiky';
  tooltip.textContent = info;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 300)}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
});


canvas.addEventListener('mouseleave', () => {
  tooltip.hidden = true;
});


canvas.addEventListener('click', async (e) => {
  const found = hitTest(...toLogical(e));
  if (!found) return;
  if (found.cat) {
    petCat();
    return;
  }
  if (found.board || found.portrait) {
    openStats();
    return;
  }
  if (found.director || found.taskBoard) {
    // the popover has no panel – the main window opens with the list
    if (COMPACT) window.office?.todoist?.open();
    else openTodos();
    return;
  }
  const w = found.worker ?? found.intern.boss;
  if (isManaged(w.id) && !COMPACT) {
    openChat(w.id);
    return;
  }
  const app = await window.office?.focus(w.id);
  if (!app) w.say('Terminál nenalezen 🤷', 2.5, 'error');
});
