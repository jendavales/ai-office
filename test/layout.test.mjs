import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD, COFFEE, CHAT_PAIRS, DESKS, DOOR, GRID, OFFICE_AREAS, OFFICE_SPOTS, OPEN_AREAS, SOFA, TASK_BOARD, WINDOW_SPOTS,
  isWalkable, randomOfficePoint, route,
} from '../renderer/src/world/layout.js';
import { lineOfSight, nearestWalkable } from '../renderer/src/world/path.js';

const places = [
  ...DESKS.map((d) => ({ name: `desk ${d.cx}/${d.deskY}`, x: d.cx, y: d.seatY })),
  ...SOFA.map((s) => ({ name: 'sofa', ...s })),
  ...COFFEE.map((s) => ({ name: 'coffee', ...s })),
  ...WINDOW_SPOTS.map((s) => ({ name: 'window', ...s })),
  ...BOARD.map((s) => ({ name: 'board', ...s })),
  ...CHAT_PAIRS.flat().map((s) => ({ name: 'chat', ...s })),
  ...Object.entries(OFFICE_SPOTS).map(([name, s]) => ({ name: `director ${name}`, ...s })),
];

test('every seat and spot is reachable from the entrance without crossing furniture', () => {
  for (const p of places) {
    const pts = route(DOOR, p);
    assert.deepEqual(pts.at(-1), { x: p.x, y: p.y }, p.name);
    // all segments except the last step into the seat stay on the floor
    let prev = nearestWalkable(GRID, DOOR.x, DOOR.y);
    for (const q of pts.slice(0, -1)) {
      assert.ok(lineOfSight(GRID, prev, q), `${p.name}: ${JSON.stringify(prev)} → ${JSON.stringify(q)}`);
      prev = q;
    }
    assert.ok(Math.hypot(prev.x - p.x, prev.y - p.y) < 12, `${p.name}: last step too long`);
  }
});

test('chat and stroll areas have free floor', () => {
  for (const a of [...OPEN_AREAS, ...OFFICE_AREAS]) {
    let free = 0;
    for (let x = a.x; x < a.x + a.w; x += 4) for (let y = a.y; y < a.y + a.h; y += 4) free += isWalkable(x, y) ? 1 : 0;
    assert.ok(free > 5, JSON.stringify(a));
  }
});

test("the director's walks stay inside the office: off the task board, face above the blinds", () => {
  // the board on wheels blocks the floor under it
  assert.ok(!isWalkable(TASK_BOARD.x + TASK_BOARD.w / 2, TASK_BOARD.y + TASK_BOARD.h - 2));
  assert.ok(!isWalkable(26, 70));
  for (let i = 0; i < 200; i++) {
    const p = randomOfficePoint();
    assert.ok(p, 'no free spot in the office');
    assert.ok(p.x >= 10 && p.x <= 58 && p.y >= 56 && p.y <= 79, JSON.stringify(p));
    assert.ok(isWalkable(p.x, p.y), JSON.stringify(p));
    // a straight walk from the board never leaves the room (no detours, so the finder does not wander off)
    for (const q of route(OFFICE_SPOTS.board, p, { detour: 0 })) assert.ok(q.y < 84 && q.x < 63, JSON.stringify(q));
  }
});
