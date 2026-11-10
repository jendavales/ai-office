/**
 * The director – that's you. Has no desk: walks about the glass office, paces on the phone and rummages
 * in the filing cabinet. Keeps the to-do list (Todoist) on a whiteboard on wheels; new deadlines send
 * the director to the board with a marker.
 */
import { DIRECTOR_LINES } from '../content/texts.js';
import { now, rand, randItem } from '../core/util.js';
import { STRIKE_MS } from '../draw/taskboard.js';
import { OFFICE_SPOTS, SPEED, randomOfficePoint } from '../world/layout.js';
import { lookFor } from './look.js';
import { Person } from './person.js';

/** Walks inside the office: no random detours (those could lead out of the door and back). */
const INDOORS = { detour: 0 };

/**
 * What the director gets up to. `secs` = how long the beat lasts (spot beats: from arrival),
 * `pause` = stop at each point of a walk (s), `spot` = walk to a fixed place (see layout OFFICE_SPOTS),
 * `arms` = what the hands do there (one picked per beat).
 */
const BEATS = {
  stroll: { secs: [15, 40], pause: [2, 6] },                                // walks around, stops and looks about
  phone: { secs: [8, 18], pause: [0.3, 1.5] },                              // paces while on the phone
  cabinet: { secs: [8, 15], spot: 'cabinet', arms: ['type'] },              // rummages in the filing cabinet
  board: { secs: [6, 12], spot: 'board', arms: ['draw', 'draw', 'think'] }, // writes on the task board, or ponders it
};

const COLUMNS = ['overdue', 'today', 'week'];

class Director extends Person {
  constructor() {
    super({ ...lookFor('ředitel', 4), headphones: false });
    this.id = 'director';
    this.name = 'Ředitel';
    this.speed = SPEED * 0.8; // unhurried
    this.place = 'office';
    this.beat = null;       // current beat { kind, until, arrived, pauseUntil, spot, arms }
    this.nextBeatAt = now() + rand(1000, 3000);
    this.todos = { configured: false, overdue: 0, today: 0, week: 0, total: 0, error: null };
    this.boardFx = [];      // notes popping up / struck out on the task board { col, kind, from, at }
    this.placeAt({ x: 40, y: 78 });
  }

  /** Facial expression follows the deadlines. */
  get face() {
    const { configured, overdue, today } = this.todos;
    if (!configured) return 'neutral';
    return overdue ? 'worried' : today ? 'neutral' : 'smile';
  }

  update(dt) {
    this.move(dt);
    const t = now();
    if (this.boardFx.length) this.boardFx = this.boardFx.filter((f) => t - f.at < STRIKE_MS);
    const beat = this.beat;
    if (!beat) {
      if (t >= this.nextBeatAt) this.pickBeat();
      return;
    }
    if (this.walking) return;
    if (t >= beat.until) {
      this.endBeat();
      return;
    }
    if (BEATS[beat.kind].pause && t >= beat.pauseUntil) this.strollOn();
  }

  pickBeat() {
    const { configured, overdue, today, week } = this.todos;
    const pending = configured ? overdue + today + week : 0;
    // with nothing pending still glances at the board now and then
    const options = [['stroll', 3], ['phone', 1.5], ['cabinet', 1], ['board', pending ? 1.5 : 0.3]];
    let roll = Math.random() * options.reduce((n, [, w]) => n + w, 0);
    const kind = options.find(([, w]) => (roll -= w) < 0)?.[0] ?? 'stroll';
    this.startBeat(kind);
  }

  startBeat(kind) {
    const spec = BEATS[kind];
    const beat = {
      kind, until: now() + rand(...spec.secs) * 1000, arrived: false, pauseUntil: 0,
      spot: spec.spot ?? null, arms: spec.arms ? randItem(spec.arms) : 'down',
    };
    this.beat = beat;
    if (!spec.spot) {
      this.strollOn();
      return;
    }
    this.walkTo(OFFICE_SPOTS[spec.spot], () => {
      if (this.beat !== beat) return;
      beat.arrived = true;
      beat.until = now() + rand(...spec.secs) * 1000;
    }, INDOORS);
  }

  /** Next leg of a walk: a random point in the office, then a stop facing the room. */
  strollOn() {
    const beat = this.beat;
    const p = randomOfficePoint();
    if (!p) {
      this.endBeat();
      return;
    }
    beat.arrived = false;
    this.walkTo(p, () => {
      if (this.beat !== beat) return;
      beat.arrived = true;
      beat.pauseUntil = now() + rand(...BEATS[beat.kind].pause) * 1000;
      beat.arms = beat.kind === 'phone' ? 'phone' : Math.random() < 0.3 ? 'think' : 'down';
    }, INDOORS);
  }

  endBeat() {
    this.beat = null;
    this.nextBeatAt = now() + rand(1500, 4000);
  }
}

export const director = new Director();

/**
 * New counts from the to-do list: changed columns of the task board get their notes popping up or struck out,
 * a worsening deadline situation gets a comment and a walk to the board.
 */
export function setDirectorTodos(todos) {
  const before = director.todos;
  director.todos = todos;
  if (!todos.configured) return;
  const t = now();
  let added = false;
  let removed = false;
  for (const col of COLUMNS) {
    const from = before[col];
    if (todos[col] === from) continue;
    const kind = todos[col] > from ? 'added' : 'removed';
    if (kind === 'added') added = true;
    else removed = true;
    director.boardFx = [...director.boardFx.filter((f) => f.col !== col), { col, kind, from, at: t }];
  }
  const moreOverdue = todos.overdue > before.overdue;
  const moreToday = todos.today > before.today && before.configured;
  if (moreOverdue) director.say(randItem(DIRECTOR_LINES.overdue), 4, 'error');
  else if (moreToday) director.say(randItem(DIRECTOR_LINES.today), 3);
  else if (todos.overdue + todos.today === 0 && before.overdue + before.today > 0) director.say(randItem(DIRECTOR_LINES.clear), 4, 'ok');
  else if (removed && !added && !director.bubble) director.say(randItem(DIRECTOR_LINES.done), 2.5, 'ok');
  if (added && director.beat?.kind !== 'board') director.startBeat('board');
}

export const updateDirector = (dt) => director.update(dt);
