'use strict';
/**
 * Persistent office data (userData/office-data.json):
 *  - profiles: the employees – every project has a team; member 1 is keyed by the project itself,
 *    further members (parallel sessions) by `project|n`. Each has a lasting name, XP and career level.
 *  - days: per-day statistics per employee (tasks, tool usage, working time, cost)
 */
const fs = require('node:fs');
const path = require('node:path');

const NAMES = [
  'Pepa', 'Jarda', 'Franta', 'Věra', 'Hanka', 'Lojza', 'Bára', 'Mirek', 'Zdena', 'Tonda',
  'Jitka', 'Karel', 'Olga', 'Venca', 'Marta', 'Ruda', 'Eva', 'Standa', 'Lenka', 'Bohouš',
  'Dáša', 'Kuba', 'Iva', 'Ota', 'Petra', 'Láďa', 'Míša', 'Radek', 'Šárka', 'Vilda',
];

const LEVELS = [
  { title: 'Junior', xp: 0 },
  { title: 'Medior', xp: 150 },
  { title: 'Senior', xp: 600 },
  { title: 'Lead', xp: 1500 },
  { title: 'Ředitel', xp: 4000 },
];
const XP_DONE = 10;
const XP_TOOL = 1;
const KEEP_DAYS = 60;

function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i += 1;
  return i;
}

/** Random employee name that isn't in `used` (names already given to other employees). */
function pickName(used = new Set(), random = Math.random) {
  const free = NAMES.filter((n) => !used.has(n));
  if (free.length) return free[Math.floor(random() * free.length)];
  const base = NAMES[Math.floor(random() * NAMES.length)];
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

const isDemo = (key) => key.startsWith('demo:');

/** Key of the n-th team member of a project (the first one is the project itself, as before teams). */
const employeeKey = (project, slot = 1) => (slot > 1 ? `${project}|${slot}` : project);

/** The first team member of `project` who isn't busy (busy = keys of sessions running right now). */
function freeMember(project, busy) {
  let slot = 1;
  while (busy.has(employeeKey(project, slot))) slot += 1;
  return { key: employeeKey(project, slot), slot };
}

const dayKey = (date = new Date()) => date.toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time

const emptyTotal = () => ({ workMs: 0, cost: 0, tools: {} });

function addTotal(total, workMs, cost, tools) {
  total.workMs += workMs;
  total.cost += cost;
  for (const [cat, n] of Object.entries(tools)) total.tools[cat] = (total.tools[cat] ?? 0) + n;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'office-data.json');
    this.data = { profiles: {}, days: {}, history: null };
    this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { profiles: saved.profiles ?? {}, days: saved.days ?? {}, history: saved.history ?? null };
    } catch { /* first run */ }
    for (const [key, p] of Object.entries(this.data.profiles)) {
      p.total ??= this.sumDays(key); // saved before all-time totals: start from the days still kept
      p.project ??= key; // saved before teams: the project's only employee
      p.slot ??= 1;
    }
    // saved while names were per session: everyone gets a lasting name again
    for (const p of Object.values(this.data.profiles)) p.name ??= pickName(this.names());
    this.prune();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this.timer);
    // demo sessions live only in memory
    const real = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !isDemo(k)));
    const days = Object.fromEntries(Object.entries(this.data.days).map(([d, perKey]) => [d, real(perKey)]));
    try {
      fs.writeFileSync(this.file, JSON.stringify({ profiles: real(this.data.profiles), days, history: this.data.history }));
    } catch (err) {
      console.error(`[ai-office] store: ${err.message}`);
    }
  }

  prune() {
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const day of Object.keys(this.data.days)) if (day < cutoff) delete this.data.days[day];
  }

  names() {
    return new Set(Object.values(this.data.profiles).map((p) => p.name).filter(Boolean));
  }

  /** Get or create an employee: `key` from employeeKey(project, slot), `label` = the project's name. */
  profile(key, label, { project = key, slot = 1 } = {}) {
    let p = this.data.profiles[key];
    if (!p) {
      p = { name: pickName(this.names()), label, project, slot, xp: 0, done: 0, since: Date.now(), total: emptyTotal() };
      this.data.profiles[key] = p;
      this.save();
    }
    return p;
  }

  /** All-time working time, cost and tools of an employee (days are kept only KEEP_DAYS). */
  total(key) {
    const p = this.data.profiles[key];
    return p ? (p.total ??= emptyTotal()) : null;
  }

  sumDays(key) {
    const sum = emptyTotal();
    for (const perKey of Object.values(this.data.days)) {
      const s = perKey[key];
      if (s) addTotal(sum, s.workMs, s.cost, s.tools);
    }
    return sum;
  }

  publicProfile(key) {
    const p = this.data.profiles[key];
    if (!p) return null;
    const level = levelFor(p.xp);
    return {
      key, name: p.name, label: p.label, project: p.project ?? key, xp: p.xp, done: p.done, level,
      title: LEVELS[level].title, levelXp: LEVELS[level].xp, nextXp: LEVELS[level + 1]?.xp ?? null,
    };
  }

  /** @returns {number|null} new level index when the employee got promoted */
  addXp(key, amount) {
    const p = this.data.profiles[key];
    if (!p) return null;
    const before = levelFor(p.xp);
    p.xp += amount;
    this.save();
    const after = levelFor(p.xp);
    return after > before ? after : null;
  }

  day(key) {
    const d = dayKey();
    this.data.days[d] ??= {};
    this.data.days[d][key] ??= { done: 0, tools: {}, workMs: 0, cost: 0 };
    return this.data.days[d][key];
  }

  recordTool(key, category) {
    const day = this.day(key);
    day.tools[category] = (day.tools[category] ?? 0) + 1;
    const total = this.total(key);
    if (total) total.tools[category] = (total.tools[category] ?? 0) + 1;
    return this.addXp(key, XP_TOOL);
  }

  recordWork(key, ms) {
    if (ms > 0 && ms < 12 * 3_600_000) {
      this.day(key).workMs += ms;
      const total = this.total(key);
      if (total) total.workMs += ms;
    }
    this.save();
  }

  recordDone(key, ms) {
    this.recordWork(key, ms);
    this.day(key).done += 1;
    const p = this.data.profiles[key];
    if (p) p.done += 1;
    return this.addXp(key, XP_DONE);
  }

  recordCost(key, usd) {
    if (usd > 0 && usd < 1000) {
      this.day(key).cost += usd;
      const total = this.total(key);
      if (total) total.cost += usd;
    }
    this.save();
  }

  /**
   * Moves employees to the project `mapProject` returns for theirs (e.g. a repository subfolder → the repository).
   * A team member who already exists there takes over the career and stats; otherwise the employee moves along.
   * Projects mapped to null or themselves stay.
   * @returns {number} how many employees were moved
   */
  rekey(mapProject) {
    let moved = 0;
    for (const [from, src] of Object.entries(this.data.profiles)) {
      const project = mapProject(src.project ?? from);
      if (!project || project === (src.project ?? from)) continue;
      const to = employeeKey(project, src.slot ?? 1);
      const label = project.split('/').filter(Boolean).pop() ?? project;
      const dst = this.data.profiles[to];
      if (!dst) {
        this.data.profiles[to] = { ...src, label, project };
      } else {
        dst.xp += src.xp;
        dst.done += src.done;
        dst.since = Math.min(dst.since, src.since);
        const srcTotal = src.total ?? emptyTotal();
        addTotal(this.total(to), srcTotal.workMs, srcTotal.cost, srcTotal.tools);
      }
      for (const perKey of Object.values(this.data.days)) {
        const s = perKey[from];
        if (!s) continue;
        const t = (perKey[to] ??= { done: 0, tools: {}, workMs: 0, cost: 0 });
        t.done += s.done;
        addTotal(t, s.workMs, s.cost, s.tools);
        delete perKey[from];
      }
      delete this.data.profiles[from];
      moved += 1;
    }
    if (moved) this.flush();
    return moved;
  }

  /** When live tracking of Claude sessions began – everything before that can only come from history. */
  liveSince() {
    const since = Object.entries(this.data.profiles)
      .filter(([key]) => !isDemo(key) && !key.startsWith('ai:'))
      .map(([, p]) => p.since);
    return since.length ? Math.min(...since) : Date.now();
  }

  /**
   * Adds what scanHistory() found in past conversations to the daily stats and to the career of each
   * project's first team member (once; the result is remembered in data.history).
   */
  importHistory(history) {
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, `${this.file}.bak-before-history`);
      } catch (err) {
        console.error(`[ai-office] store backup: ${err.message}`);
      }
    }
    const keys = Object.keys(history.projects).sort((a, b) => history.projects[a].since - history.projects[b].since);
    for (const key of keys) {
      const src = history.projects[key];
      const existed = Boolean(this.data.profiles[key]);
      const p = this.profile(key, src.label);
      p.since = existed ? Math.min(p.since, src.since) : src.since;
      p.xp += src.xp;
      p.done += src.done;
    }
    for (const [day, perKey] of Object.entries(history.days)) {
      for (const [key, s] of Object.entries(perKey)) {
        this.data.days[day] ??= {};
        const t = (this.data.days[day][key] ??= { done: 0, tools: {}, workMs: 0, cost: 0 });
        t.done += s.done;
        t.workMs += s.workMs;
        t.cost += s.cost;
        for (const [cat, n] of Object.entries(s.tools)) t.tools[cat] = (t.tools[cat] ?? 0) + n;
        const total = this.total(key); // all-time, including days older than KEEP_DAYS
        if (total) addTotal(total, s.workMs, s.cost, s.tools);
      }
    }
    this.data.history = { importedAt: Date.now(), until: history.until, sessions: history.sessions, projects: keys.length };
    this.prune();
    this.flush();
  }

  /** Aggregates for the stats panel (rows per employee): today, last 7 days, everyone ever, employee and project of the week. */
  stats() {
    const today = dayKey();
    const weekStart = dayKey(new Date(Date.now() - 6 * 86_400_000));
    const collect = (filter) => {
      const rows = new Map();
      for (const [day, perKey] of Object.entries(this.data.days)) {
        if (!filter(day)) continue;
        for (const [key, s] of Object.entries(perKey)) {
          if (isDemo(key) && !this.showDemo) continue;
          const row = rows.get(key) ?? { ...this.publicProfile(key), key, done: 0, workMs: 0, cost: 0, tools: {} };
          row.done += s.done;
          row.workMs += s.workMs;
          row.cost += s.cost;
          for (const [cat, n] of Object.entries(s.tools)) row.tools[cat] = (row.tools[cat] ?? 0) + n;
          rows.set(key, row);
        }
      }
      return [...rows.values()].sort((a, b) => b.done - a.done || b.workMs - a.workMs);
    };
    const week = collect((d) => d >= weekStart);
    const top = week.find((r) => r.done > 0) ?? null;
    const total = Object.keys(this.data.profiles)
      .filter((key) => !isDemo(key) || this.showDemo)
      .map((key) => {
        const t = this.total(key);
        return { ...this.publicProfile(key), since: this.data.profiles[key].since, workMs: t.workMs, cost: t.cost, tools: t.tools };
      })
      .sort((a, b) => b.done - a.done || b.xp - a.xp);
    const projects = new Map(); // the whole team's work counts for the project of the week
    for (const r of week) {
      const key = r.project ?? r.key;
      const p = projects.get(key) ?? { key, label: r.label, done: 0, people: 0 };
      p.done += r.done;
      p.people += 1;
      projects.set(key, p);
    }
    return {
      today: collect((d) => d === today),
      week,
      total,
      employeeOfWeek: top ? { key: top.key, name: top.name, label: top.label, level: top.level, title: top.title, done: top.done } : null,
      projectOfWeek: [...projects.values()].sort((a, b) => b.done - a.done).find((p) => p.done > 0) ?? null,
    };
  }
}

module.exports = { Store, LEVELS, NAMES, pickName, employeeKey, freeMember, XP_DONE, XP_TOOL, dayKey };
