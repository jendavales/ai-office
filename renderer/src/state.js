/** Shared mutable renderer state. */

/** Values written from several modules (imports are read-only, so they live on one object). */
export const state = {
  soundOn: true,
  limits: null,          // { fiveHour, week, ts } from the status line
  port: 4747,
  employeeOfWeek: null,  // from the stats module (portrait on the wall)
  projectOfWeek: null,   // from the stats module
  forceHour: null,       // test hook: preview day/night
};

// ---- idle behaviour selection & conversations

/** @type {Set<Convo>} */
export const convos = new Set();


/** @type {Map<string, Worker>} */
export const workers = new Map();

export const stats = { doneKey: `ai-office:done:${new Date().toISOString().slice(0, 10)}`, done: 0 };

try {
  stats.done = Number(localStorage.getItem(stats.doneKey)) || 0;
} catch { /* storage unavailable */ }


export function bumpDone() {
  stats.done += 1;
  try {
    localStorage.setItem(stats.doneKey, String(stats.done));
  } catch { /* storage unavailable */ }
}
