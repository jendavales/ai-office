/** The to-do list's logic: calendar days, deadline buckets, filters, ordering (pure, tested). */

/** Local calendar day as YYYY-MM-DD – sorts and compares as a string. */
export const dayKey = (date = new Date()) => date.toLocaleDateString('sv-SE');

const utc = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** `n` days after a YYYY-MM-DD day (calendar arithmetic, no DST surprises). */
export const addDays = (day, n) => new Date(utc(day) + n * 86_400_000).toISOString().slice(0, 10);

export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86_400_000);

export const BUCKETS = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'];

export const BUCKET_CZ = { overdue: 'Po termínu', today: 'Dnes', tomorrow: 'Zítra', week: 'Tento týden', later: 'Později', none: 'Bez termínu' };

export function bucketOf(task, today) {
  if (!task.due) return 'none';
  if (task.due < today) return 'overdue';
  if (task.due === today) return 'today';
  if (task.due === addDays(today, 1)) return 'tomorrow';
  if (task.due <= addDays(today, 6)) return 'week';
  return 'later';
}

/** Deadline filters of the panel: a key below, or { until: 'YYYY-MM-DD' } = due on or before that day. */
export const FILTERS = [['today', 'Dnes'], ['week', '7 dní'], ['all', 'Vše'], ['none', 'Bez termínu']];

export function matches(task, filter, today) {
  if (filter && typeof filter === 'object') return Boolean(task.due) && task.due <= filter.until;
  switch (filter) {
    case 'today': return Boolean(task.due) && task.due <= today; // overdue tasks are still due today
    case 'week': return Boolean(task.due) && task.due <= addDays(today, 6);
    case 'none': return !task.due;
    default: return true;
  }
}

/** Earliest deadline first (none last), then the time of day, priority (4 = p1), Todoist's own order. */
export function compareTasks(a, b) {
  if (a.due !== b.due) {
    if (!a.due || !b.due) return a.due ? -1 : 1;
    return a.due < b.due ? -1 : 1;
  }
  if (a.time !== b.time) {
    if (!a.time || !b.time) return a.time ? -1 : 1;
    return a.time < b.time ? -1 : 1;
  }
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.order - b.order;
}

/** Tasks passing the filter, grouped by deadline bucket in bucket order; empty groups left out. */
export function groupTasks(tasks, filter, today) {
  const groups = new Map(BUCKETS.map((b) => [b, []]));
  for (const t of tasks) if (matches(t, filter, today)) groups.get(bucketOf(t, today)).push(t);
  return [...groups].filter(([, list]) => list.length)
    .map(([bucket, list]) => ({ bucket, label: BUCKET_CZ[bucket], tasks: list.sort(compareTasks) }));
}

/** What the director keeps an eye on: how much is overdue, due today and due later this week (next 6 days). */
export function summarize(tasks, today) {
  let overdue = 0;
  let due = 0;
  let week = 0;
  const weekEnd = addDays(today, 6);
  for (const t of tasks) {
    if (!t.due) continue;
    if (t.due < today) overdue += 1;
    else if (t.due === today) due += 1;
    else if (t.due <= weekEnd) week += 1;
  }
  return { overdue, today: due, week, total: tasks.length };
}

const WEEKDAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** Deadline label: dnes · zítra · včera · 'pá 14. 11.' within a week · '3. 1.' (with the year when it differs). */
export function fmtDue(due, today) {
  if (!due) return 'bez termínu';
  const diff = daysBetween(today, due);
  if (diff === 0) return 'dnes';
  if (diff === 1) return 'zítra';
  if (diff === -1) return 'včera';
  const [y, m, d] = due.split('-').map(Number);
  const short = `${d}. ${m}.`;
  if (Math.abs(diff) <= 6) return `${WEEKDAYS[new Date(utc(due)).getUTCDay()]} ${short}`;
  return y === Number(today.slice(0, 4)) ? short : `${short} ${y}`;
}

/** Text for an empty list under the chosen filter. */
export function emptyText(filter) {
  if (filter && typeof filter === 'object') return 'Do tohoto data nic nezbývá.';
  return { today: 'Na dnešek nic nezbývá 🎉', week: 'Tento týden je čisto.', none: 'Všechno má termín.' }[filter] ?? 'Žádné úkoly.';
}
