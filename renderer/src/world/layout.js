/**
 * Floor plan of the branch office of "Papírna Svišť" (a made-up paper company):
 * glass-walled manager's office and conference room along the back wall, kitchenette,
 * reception by the entrance, a bullpen of desk pods and a break room with TV.
 * Walking uses a grid path finder (world/path.js), so routes differ every time.
 */
import { hash } from '../core/util.js';
import { createGrid, findPath, randomPoint, walkable } from './path.js';

export const SPEED = 60; // logical px / s

/** Floor starts below the back wall. */
export const FLOOR_Y = 46;

/** Glass front walls of the back rooms (floor y of the glass). */
export const GLASS_Y = 84;

export const ROOMS = {
  manager: { x: 0, w: 64, door: [44, 58] },
  conference: { x: 67, w: 83, door: [126, 142] },
};

export const DOOR = { x: 298, y: 52 };


export const DESKS = [];

// bullpen: two rows of desk pods (two desks side by side)
for (const deskY of [102, 140]) {
  for (const cx of [24, 64, 120, 160]) {
    DESKS.push({ cx, deskY, seatY: deskY + 28, seed: DESKS.length * 7919 + 13, owner: null });
  }
}
/** Manager's office: no desk – the director does not sit. A whiteboard on wheels with the to-do list (board face). */
export const TASK_BOARD = { x: 7, y: 35, w: 38, h: 27 };

export const SOFA = [0, 1, 2, 3].map((i) => ({ x: 253 + i * 14, y: 160, sofa: true, owner: null }));

export const COFFEE = [0, 1, 2, 3, 4].map((i) => ({ x: 174 + i * 9, y: 57, owner: null }));

/** Fallback chat spots; normally a random free place is picked (see chatPair). */
export const CHAT_PAIRS = [
  [{ x: 84, y: 93 }, { x: 99, y: 93 }],     // corridor in front of the glass rooms
  [{ x: 214, y: 92 }, { x: 229, y: 92 }],   // by the reception
  [{ x: 206, y: 140 }, { x: 221, y: 140 }], // break room
].map((pair) => pair.map((spot) => ({ ...spot, owner: null })));

/** In front of the conference room window – where frustrated employees clear their heads. */
export const WINDOW_SPOTS = [{ x: 126, y: 52, owner: null }, { x: 140, y: 52, owner: null }];

export const IDLE_POOLS = { coffee: COFFEE, sofa: SOFA, window: WINDOW_SPOTS };

/** Whiteboard spots in the conference room for plan-mode "meetings". */
export const BOARD = [80, 92, 104].map((x) => ({ x, y: 54, owner: null }));


// ---- walkable floor

const rect = (x, y, w, h) => ({ x, y, w, h });

export const OBSTACLES = [
  // glass rooms: front walls (with door gaps) and side walls
  rect(0, GLASS_Y, ROOMS.manager.door[0], 4),
  rect(ROOMS.manager.door[1], GLASS_Y, ROOMS.conference.door[0] - ROOMS.manager.door[1], 4),
  rect(ROOMS.conference.door[1], GLASS_Y, 151 - ROOMS.conference.door[1], 4),
  rect(63, FLOOR_Y, 4, GLASS_Y - FLOOR_Y),
  rect(148, FLOOR_Y, 4, GLASS_Y - FLOOR_Y),
  // manager's office: filing cabinet, task board on wheels (its stand)
  rect(50, FLOOR_Y, 12, 8),
  rect(6, 51, 40, 21),
  // conference table
  rect(74, 58, 68, 17),
  // vending machine
  rect(153, FLOOR_Y, 14, 4),
  // reception counter
  rect(230, 58, 50, 17),
  // break room: copier, TV with cabinet, sofa, floor lamp
  rect(199, 104, 20, 13),
  rect(250, 100, 52, 30),
  rect(237, 148, 76, 15),
  rect(303, 130, 12, 10),
  // desks
  ...DESKS.map((d) => rect(d.cx - 20, d.deskY - 1, 40, 21)),
];

export const GRID = createGrid({ width: 320, height: 180, minY: FLOOR_Y + 2, obstacles: OBSTACLES });

export const isWalkable = (x, y) => walkable(GRID, x, y);

export const route = (from, to, opts) => findPath(GRID, from, to, opts);

/** Open areas where people stroll and chat (corridor, by the reception, aisles, break room). */
export const OPEN_AREAS = [
  rect(70, 88, 120, 10),
  rect(186, 80, 100, 22),
  rect(190, 96, 40, 80),
  rect(4, 124, 180, 14),
  rect(226, 132, 90, 14),
];

export function randomFloorPoint(area = null) {
  return randomPoint(GRID, Math.random, area ?? OPEN_AREAS[Math.floor(Math.random() * OPEN_AREAS.length)]);
}


/**
 * Manager's office: where the director strolls – in front of the task board and along its right side,
 * but not the gap behind it against the back wall. Stops keep the feet at y 79 at most so the face stays
 * above the blinds of the glass front.
 */
export const OFFICE_AREAS = [rect(10, 74, 48, 5), rect(50, 56, 8, 23)];

/** The director's stops: the filing cabinet and the task board (facing it, marker in hand). */
export const OFFICE_SPOTS = {
  cabinet: { x: 55, y: 57 },
  board: { x: 24, y: 77 },
};

export function randomOfficePoint() {
  return randomPoint(GRID, Math.random, OFFICE_AREAS[Math.floor(Math.random() * OFFICE_AREAS.length)]);
}


/** Two free spots 15 px apart somewhere in the open areas (falls back to CHAT_PAIRS). */
export function chatPair(busy = []) {
  for (let i = 0; i < 25; i++) {
    const p = randomFloorPoint();
    if (!p) continue;
    const q = { x: p.x + 15, y: p.y };
    if (!isWalkable(q.x, q.y)) continue;
    if (busy.some((b) => Math.hypot(b.x - p.x, b.y - p.y) < 22 || Math.hypot(b.x - q.x, b.y - q.y) < 22)) continue;
    return [{ ...p, owner: null }, { ...q, owner: null }];
  }
  return CHAT_PAIRS.find((pair) => !pair[0].owner && !pair[1].owner) ?? null;
}


export function claimSeat(worker) {
  const desk = DESKS.find((d) => !d.owner);
  if (desk) {
    desk.owner = worker;
    return { x: desk.cx, y: desk.seatY, desk };
  }
  const spot = SOFA.find((s) => !s.owner);
  if (spot) {
    spot.owner = worker;
    return spot;
  }
  const h = hash(worker.id);
  return { x: 200 + (h % 24), y: 100 + ((h >>> 8) % 40), standing: true };
}


export function releaseSeat(worker) {
  if (worker.seat.desk) worker.seat.desk.owner = null;
  else if (worker.seat.sofa) worker.seat.owner = null;
}


/** Where interns stand around their boss's seat. */
export function internSpot(seat, slot) {
  const [dx, dy] = [[-14, 1], [14, 1], [0, 10]][slot];
  return { x: seat.x + dx, y: seat.y + dy };
}
