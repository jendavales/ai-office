/**
 * Todoist's quick-add shortcuts, typed straight into the new-task field (pure, tested):
 *
 *   !!1 … !!4 / p1 … p4   priority (1 = highest)
 *   #projekt              project – case and diacritics don't matter, names with spaces work too
 *   @štítek               label (any number; punctuation right after it stays in the text)
 *   dnes · zítra · pozítří · pátek · v pátek · příští pátek · příští týden · za 3 dny · 12. 11. · 12. 11. 2027 · 2026-11-12
 *                         due date (Czech and English words, "za N …" up to 999); one date counts, the rest stays text
 *   14:00 · v 14:00       time; a time alone leaves the date to the caller (`due` stays null)
 *   … // popis            everything after // is the description
 *
 * The shortcuts are removed from the task text; what's left is the content.
 */
import { addDays, dayKey } from './model.js';

/**
 * Lowercase without diacritics, same length as the (NFC) input so match positions stay valid – folded per code
 * point, and a character whose folded form would change the length (Hangul, kana with voicing marks, a lone
 * combining mark) is kept as it is.
 */
export function fold(s) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC')) {
    const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

/** `p1 … p4` and `!!1 … !!4` → Todoist priority (4 = p1 … 1 = none). */
const PRIORITY = /(?<=^|\s)(?:!!|p)([1-4])(?=\s|$)/i;
const LABEL = /(?<=^|\s)@([^\s@#]+?)(?=[,.;:!?]*(?:\s|$))/g; // "@nákup," – the comma is not part of the name
const PROJECT_AT = /(?<=^|\s)#(?=\S)/g;
const DESCRIPTION = /(?:^|\s)\/\/(?=\s|$)/;
const TIME = /(?<=^|\s)(?:(?:v|ve|at)\s+)?(\d{1,2}):(\d{2})(?=\s|$)/g;

const CZ_DAYS = [
  ['nedele', 'nedeli', 'sunday'], ['pondeli', 'monday'], ['utery', 'uteri', 'tuesday'], ['streda', 'stredu', 'wednesday'],
  ['ctvrtek', 'thursday'], ['patek', 'friday'], ['sobota', 'sobotu', 'saturday'],
];
const DAY_WORD = CZ_DAYS.flat().join('|');
const weekdayOf = (word) => CZ_DAYS.findIndex((forms) => forms.includes(word));

/** JS weekday (0 = Sunday) of a YYYY-MM-DD day. */
const weekday = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The nearest `wd` on or after `today` (`strict`: after today). */
function nextWeekday(today, wd, strict) {
  let diff = (wd - weekday(today) + 7) % 7;
  if (strict && diff === 0) diff = 7;
  return addDays(today, diff);
}

const pad = (n) => String(n).padStart(2, '0');

/** A calendar date typed as D. M. [YYYY] – without the year, the next such day (this year or the next). */
function explicitDay(d, m, y, today) {
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  const build = (year) => {
    const day = `${year}-${pad(m)}-${pad(d)}`;
    const check = new Date(Date.UTC(year, m - 1, d));
    return check.getUTCMonth() === m - 1 ? day : null; // 31. 2. is not a day
  };
  if (y != null) return build(y < 100 ? 2000 + y : y);
  const thisYear = build(Number(today.slice(0, 4)));
  return thisYear && thisYear >= today ? thisYear : build(Number(today.slice(0, 4)) + 1);
}

/** Calendar months later, clamped to the month's last day (31. 1. + 1 month = 28. 2.). */
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}

/*
 * Date phrases, tried in this order on the folded text (every occurrence, so "Verze 2.0. vydat 12. 11." finds the
 * date); each resolves to a YYYY-MM-DD day or null (= not a date). A D. M. year is 20xx or two digits glued to the
 * dot (12.11.27) – "5. 12. 10 balíčků" is the 5th of December. "za N …" stops at three digits so the day math
 * can't overflow.
 */
const DATES = [
  [/(?<=^|\s)(\d{4})-(\d{2})-(\d{2})(?=\s|$)/g, (m, today) => explicitDay(Number(m[3]), Number(m[2]), Number(m[1]), today)],
  [/(?<=^|\s)(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(20\d{2})|(\d{2}))?(?=\s|$)/g, (m, today) => {
    const y = m[3] ?? m[4];
    return explicitDay(Number(m[1]), Number(m[2]), y == null ? null : Number(y), today);
  }],
  [/(?<=^|\s)(?:za|in)\s+(\d{1,3})\s+(dni|dny|den|dnu|days?|tydnu|tydny|tyden|weeks?|mesicu|mesice|mesic|months?)(?=\s|$)/g, (m, today) => {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit.startsWith('d')) return addDays(today, n);
    if (unit.startsWith('t') || unit.startsWith('w')) return addDays(today, 7 * n);
    return addMonths(today, n);
  }],
  [/(?<=^|\s)(?:za|in a)\s+(tyden|week|mesic|month)(?=\s|$)/g, (m, today) => (m[1].startsWith('t') || m[1] === 'week' ? addDays(today, 7) : addMonths(today, 1))],
  [/(?<=^|\s)(?:pristi|next)\s+(tyden|week)(?=\s|$)/g, (m, today) => nextWeekday(today, 1, true)],
  [new RegExp(`(?<=^|\\s)(?:pristi|next)\\s+(${DAY_WORD})(?=\\s|$)`, 'g'), (m, today) => nextWeekday(today, weekdayOf(m[1]), true)],
  [new RegExp(`(?<=^|\\s)(?:(?:v|ve|on)\\s+)?(${DAY_WORD})(?=\\s|$)`, 'g'), (m, today) => nextWeekday(today, weekdayOf(m[1]), false)],
  [/(?<=^|\s)(dnes|today|zitra|tomorrow|pozitri)(?=\s|$)/g, (m, today) => (m[1] === 'dnes' || m[1] === 'today' ? today : m[1] === 'pozitri' ? addDays(today, 2) : addDays(today, 1))],
];

const cut = (text, index, length) => text.slice(0, index) + ' ' + text.slice(index + length);
/** Single spaces, and punctuation a cut left alone glued back to its word ("Koupit , chleba" → "Koupit, chleba"; "!!5" stays). */
const tidy = (text) => text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?]+)(?=\s|$)/g, '$1').trim();

/**
 * Finds the project a `#…` token names: the longest run of words (up to four) that is a project name,
 * otherwise a single word that starts exactly one project's name. Trailing punctuation is not part of the
 * name. Returns { project, length } – the length of the matched text after `#`, as typed (any spacing) – or null.
 */
function matchProject(rest, projects) {
  const byName = new Map(projects.map((p) => [fold(p.name), p]));
  const typed = (k) => rest.match(new RegExp(`^\\S+(?:\\s+\\S+){${k - 1}}`))?.[0].replace(/[,.;:!?]+$/, '');
  for (let k = 4; k >= 1; k -= 1) {
    const name = typed(k);
    const project = name && byName.get(fold(name).replace(/\s+/g, ' '));
    if (project) return { project, length: name.length };
  }
  const first = typed(1);
  if (!first) return null; // "#," – no name to complete
  const starts = projects.filter((p) => fold(p.name).startsWith(fold(first)));
  return starts.length === 1 ? { project: starts[0], length: first.length } : null;
}

/**
 * Parses the new-task text. `projects` are the office's { id, name, inbox } projects, `today` a YYYY-MM-DD day.
 * Returns what to send and what was recognised; a `#…` naming no known project stays in the text and is
 * reported as `unknownProject`.
 */
export function parseQuickAdd(input, { projects = [], today = dayKey() } = {}) {
  let text = String(input ?? '').normalize('NFC');
  const out = {
    content: '', description: '', priority: null, projectId: null, project: null, unknownProject: null,
    labels: [], due: null, dueText: null, time: null,
  };

  const desc = text.match(DESCRIPTION);
  if (desc) {
    out.description = tidy(text.slice(desc.index + desc[0].length));
    text = text.slice(0, desc.index);
  }

  const prio = text.match(PRIORITY);
  if (prio) {
    out.priority = 5 - Number(prio[1]);
    text = cut(text, prio.index, prio[0].length);
  }

  const labels = [...text.matchAll(LABEL)];
  for (const m of labels) if (!out.labels.some((l) => fold(l) === fold(m[1]))) out.labels.push(m[1]); // @Doma = @doma, the first spelling wins
  for (const m of labels.reverse()) text = cut(text, m.index, m[0].length); // right to left so earlier positions stay valid

  for (const m of text.matchAll(PROJECT_AT)) {
    const found = matchProject(text.slice(m.index + 1), projects);
    if (found) {
      out.projectId = found.project.id;
      out.project = found.project.name;
      text = cut(text, m.index, 1 + found.length);
      break;
    }
    out.unknownProject ??= text.slice(m.index).match(/^#\S+/)[0];
  }

  const folded = fold(text);
  dates: for (const [re, resolve] of DATES) {
    for (const m of folded.matchAll(re)) {
      const due = resolve(m, today);
      if (!due) continue;
      out.due = due;
      out.dueText = text.slice(m.index, m.index + m[0].length);
      text = cut(text, m.index, m[0].length);
      break dates;
    }
  }

  const time = [...fold(text).matchAll(TIME)].find((m) => Number(m[1]) < 24 && Number(m[2]) < 60);
  if (time) {
    out.time = `${pad(time[1])}:${time[2]}`;
    text = cut(text, time.index, time[0].length);
  }

  out.content = tidy(text);
  return out;
}

/** True when the text carries any shortcut (something to show in the preview). */
export const hasMacros = (p) => Boolean(p.priority || p.projectId || p.unknownProject || p.labels.length || p.due || p.time || p.description);
