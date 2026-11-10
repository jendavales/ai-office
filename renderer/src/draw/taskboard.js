/**
 * The director's task board: a whiteboard on wheels in the manager's office. One sticky note per to-do task
 * in three columns (overdue, due today, due within the week) – the amount at a glance, no numbers.
 * New notes pop up, finished ones are struck out before they disappear (director.boardFx).
 */
import { R, text } from '../core/canvas.js';
import { C } from '../core/palette.js';
import { clamp, now, shade } from '../core/util.js';
import { TASK_BOARD } from '../world/layout.js';

/** How long a finished note stays struck out (ms); board effects older than that are dropped. */
export const STRIKE_MS = 1200;

const GROW_MS = 300;
const STAGGER_MS = 80;
const MAX_NOTES = 8;

const COLUMNS = [
  { key: 'overdue', label: 'HOŘÍ', labelColor: C.red, color: C.red },
  { key: 'today', label: 'DNES', labelColor: C.ink, color: C.yellow },
  { key: 'week', label: 'PAK', labelColor: C.metalDark, color: C.lime },
];

/** A sticky note with a scribble, scaled by `k` around its centre (0..1 while it pops up). */
function note(x, y, color, k = 1) {
  if (k <= 0) return;
  const mx = x + 2;
  const my = y + 1.75;
  R(mx - 2 * k, my - 1.75 * k, 4 * k, 3.5 * k, color);
  R(mx - 1.3 * k, my - 0.55 * k, 2.6 * k, 0.5 * k, shade(color, -0.4));
}

/** Diagonal ink strike over a finished note. */
function strike(x, y) {
  for (let i = 0; i < 4; i++) R(x + i, y + (i * 2.5) / 3, 1, 1, C.ink);
}

function smiley(cx, cy) {
  R(cx - 2.5, cy - 2.5, 1.5, 1.5, C.green);
  R(cx + 1, cy - 2.5, 1.5, 1.5, C.green);
  R(cx - 2.5, cy + 0.5, 1, 1, C.green);
  R(cx + 1.5, cy + 0.5, 1, 1, C.green);
  R(cx - 1.5, cy + 1.5, 3, 1, C.green);
}

function drawColumn(c, count, fx, t) {
  const { x, y } = TASK_BOARD;
  const cx = x + 1 + c * 12;
  const col = COLUMNS[c];
  if (c > 0) R(cx, y + 5, 0.5, TASK_BOARD.h - 8, C.metal);
  text(col.label, cx + 6, y + 4.3, 2.2, col.labelColor);
  const pos = (i) => [cx + 1.5 + (i % 2) * 5, y + 6.5 + Math.floor(i / 2) * 4.5 + (i % 2) * 0.3];
  const shown = Math.min(count, MAX_NOTES);
  for (let i = 0; i < shown; i++) {
    const [nx, ny] = pos(i);
    const k = fx?.kind === 'added' && i >= fx.from ? clamp((t - fx.at - (i - fx.from) * STAGGER_MS) / GROW_MS, 0, 1) : 1;
    if (i === MAX_NOTES - 1 && count > MAX_NOTES) {
      // more than fits: the last slot is a little stack
      note(nx + 0.8, ny - 0.8, shade(col.color, -0.2), k);
      note(nx + 0.4, ny - 0.4, shade(col.color, -0.1), k);
    }
    note(nx, ny, col.color, k);
  }
  if (fx?.kind === 'removed') {
    for (let i = count; i < Math.min(fx.from, MAX_NOTES); i++) {
      const [nx, ny] = pos(i);
      note(nx, ny, col.color);
      strike(nx, ny);
    }
  }
}


export function drawTaskBoard(director) {
  const { x, y, w, h } = TASK_BOARD;
  const t = now();
  // stand on wheels
  R(x + 3, y + h, 1.5, 9, C.metalDark);
  R(x + w - 4.5, y + h, 1.5, 9, C.metalDark);
  R(x + 3, y + h + 5, w - 6, 1, C.metalDark);
  R(x + 2.5, y + h + 9, 2.5, 1.5, C.ink);
  R(x + w - 5, y + h + 9, 2.5, 1.5, C.ink);
  // board with a marker tray
  R(x, y, w, h, C.metalDark);
  R(x + 1, y + 1, w - 2, h - 2, C.white);
  R(x + 2, y + h - 2, w - 4, 1.2, C.metal);
  R(x + 5, y + h - 2.8, 2.5, 0.8, C.red);
  R(x + 9, y + h - 2.8, 2.5, 0.8, C.blue);

  const todos = director.todos;
  if (!todos.configured) {
    text('?', x + w / 2, y + 17, 7, C.metal);
    return;
  }
  const fx = director.boardFx.filter((f) => t - f.at < STRIKE_MS);
  COLUMNS.forEach((col, c) => drawColumn(c, todos[col.key] ?? 0, fx.find((f) => f.col === col.key), t));
  if (!todos.overdue && !todos.today && !todos.week && !fx.length) smiley(x + w / 2, y + h / 2);
}
