/** Frame loop: update and draw. */
import { H, OX, OY, S, W, canvas, ctx } from './core/canvas.js';
import { C } from './core/palette.js';
import { now } from './core/util.js';
import { chairBack } from './draw/figure.js';
import {
  drawConferenceGlass, drawConferenceTable, drawCopier, drawDesk, drawManagerGlass, drawReception, drawSofa,
} from './draw/furniture.js';
import { drawEmptyOverlay, drawOverlay } from './draw/overlay.js';
import { drawDirector, drawIntern, drawWorker } from './draw/people.js';
import { drawRoom } from './draw/room.js';
import { drawTaskBoard } from './draw/taskboard.js';
import { drawLifeOverlay, lifeItems, updateLife } from './life/index.js';
import { drawLighting } from './life/lighting.js';
import { drawParticles } from './life/particles.js';
import { director, updateDirector } from './entities/director.js';
import { convos, workers } from './state.js';
import { DESKS, GLASS_Y, TASK_BOARD } from './world/layout.js';

export function draw(t, dt) {
  const date = new Date();
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(OX, OY, W * S, H * S);
  ctx.clip();

  drawRoom(t, date);

  // depth-sorted scene objects
  const items = [];
  for (const d of DESKS) {
    items.push({ y: d.deskY + 17, draw: () => drawDesk(d, t) });
    if (!d.owner || d.owner.place !== 'desk' || d.owner.walking) {
      items.push({ y: d.seatY - 0.1, draw: () => chairBack(d.cx, d.seatY, false) });
    }
  }
  items.push({ y: 161, draw: drawSofa });
  items.push({ y: GLASS_Y + 3, draw: drawManagerGlass });
  items.push({ y: GLASS_Y + 3, draw: drawConferenceGlass });
  items.push({ y: 74, draw: drawConferenceTable });
  items.push({ y: 74.5, draw: () => drawReception(t) });
  const copying = [...workers.values()].some((w) => Math.hypot(w.x - 209, w.y - 120) < 12);
  items.push({ y: 116, draw: () => drawCopier(t, copying) });
  items.push({ y: TASK_BOARD.y + TASK_BOARD.h + 10, draw: () => drawTaskBoard(director) }); // the director at the board stands in front
  items.push({ y: director.y, draw: () => drawDirector(director, t) });
  for (const w of workers.values()) {
    // ghosts float above everything (they fly through walls and desks)
    if (!w.gone) items.push({ y: w.ghost ? 1000 + w.y : w.y, draw: () => drawWorker(w, t) });
    for (const i of w.interns) items.push({ y: i.y + 0.2, draw: () => drawIntern(i, t) });
  }
  items.push(...lifeItems(t));
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();

  drawLighting(t, date);
  drawParticles();
  drawOverlay(t);
  drawLifeOverlay(t);
  drawEmptyOverlay(dt);
  ctx.restore();
}


export let last = now();

export function frame() {
  const ts = now();
  const dt = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  for (const convo of convos) convo.tick(ts);
  updateLife(dt);
  updateDirector(dt);
  for (const [id, w] of workers) {
    w.update(dt);
    if (w.gone && w.interns.length === 0) workers.delete(id);
  }
  draw(ts / 1000, dt);
  requestAnimationFrame(frame);
}
