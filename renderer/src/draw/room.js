/** Static room: floors, back wall with windows, whiteboard, kitchenette, wall panels, door. */
import { H, OX, OY, R, S, W, ctx, text } from '../core/canvas.js';
import { C } from '../core/palette.js';
import { noise, pad2, shade } from '../core/util.js';
import { figure } from './figure.js';
import { drawTV, plant } from './furniture.js';
import { lookFor } from '../entities/look.js';
import { WEEKDAYS, fmtReset, fuelColor, hourOf, remaining, strikeActive, strikeUntil } from '../limits.js';
import { state, stats, workers } from '../state.js';
import { DOOR, FLOOR_Y, GLASS_Y } from '../world/layout.js';

/** Plan-mode diagram on the whiteboard, drawn step by step. */
export function drawDiagram(x, y, t) {
  const parts = [
    () => R(x + 3, y + 3, 9, 5, C.blue),
    () => R(x + 12, y + 5, 5, 1, C.ink),
    () => R(x + 17, y + 3, 9, 5, C.green),
    () => R(x + 21, y + 8, 1, 4, C.ink),
    () => R(x + 17, y + 12, 9, 5, C.orange),
    () => R(x + 26, y + 5, 4, 1, C.ink),
    () => R(x + 30, y + 3, 6, 5, C.purple),
    () => { R(x + 4, y + 12, 9, 1, C.metal); R(x + 4, y + 15, 7, 1, C.metal); R(x + 4, y + 18, 10, 1, C.metal); },
  ];
  const shown = Math.floor((t * 0.8) % (parts.length + 4));
  parts.slice(0, Math.min(shown + 1, parts.length)).forEach((draw) => draw());
}


export function drawPortrait(t) {
  R(4, 6, 20, 26, '#c8a24a');
  R(5, 7, 18, 24, '#a8842e');
  R(6, 8, 16, 18, '#29366f');
  if (state.employeeOfWeek) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(OX + 6 * S, OY + 8 * S, 16 * S, 18 * S);
    ctx.clip();
    figure(14, 40, lookFor(state.employeeOfWeek.key, state.employeeOfWeek.level), { view: 'front', arms: 'down', t }, 1.25);
    ctx.restore();
  } else {
    text('?', 14, 20, 7, C.metal);
  }
  R(6, 26, 16, 4, '#a8842e');
  text('★ TÝDNE', 14, 29.3, 2.4, C.yellow);
}


export function skyFor(hour) {
  if (hour >= 7 && hour < 17) return { top: '#73eff7', bottom: '#41a6f6', city: '#5d6dd8', night: false };
  if (hour >= 17 && hour < 20) return { top: '#ef7d57', bottom: '#b55088', city: '#5d275d', night: false };
  if (hour >= 5 && hour < 7) return { top: '#f4d35e', bottom: '#ef7d57', city: '#5d275d', night: false };
  return { top: '#1a1c2c', bottom: '#29366f', city: '#14162a', night: true };
}


export function drawWindow(x, y, w, h, sky, t) {
  R(x - 2, y - 2, w + 4, h + 4, C.trim);
  R(x, y, w, h / 2, sky.top);
  R(x, y + h / 2, w, h / 2, sky.bottom);
  if (sky.night) {
    for (let i = 0; i < 6; i++) {
      if ((Math.floor(t * 0.7) + i) % 5) R(x + 2 + noise(x + i) * (w - 4), y + 1 + noise(x * i + 3) * 8, 0.6, 0.6, C.white);
    }
  }
  let bx = x;
  let i = 0;
  while (bx < x + w) {
    const bw = 5 + Math.floor(noise(x + i * 17) * 6);
    const bh = 6 + Math.floor(noise(x * 3 + i) * 12);
    const bwClamped = Math.min(bw, x + w - bx);
    R(bx, y + h - bh, bwClamped, bh, sky.city);
    if (sky.night) {
      for (let wy = y + h - bh + 2; wy < y + h - 1; wy += 3) {
        for (let wx = bx + 1; wx < bx + bwClamped - 1; wx += 2) {
          if (noise(wx * 31 + wy * 7) > 0.6) R(wx, wy, 1, 1, C.yellow);
        }
      }
    }
    bx += bw;
    i += 1;
  }
  R(x + w / 2 - 0.5, y, 1, h, C.trim);
  R(x, y + h / 2 - 0.5, w, 1, C.trim);
  R(x - 3, y + h + 2, w + 6, 2, C.wallLight);
}


/** Wall panel under the clock: remaining % of the 5h window and the week. */
export function drawLimits(x, y) {
  const w = 28;
  const h = 15;
  R(x, y, w, h, C.trim);
  R(x + 1, y + 1, w - 2, h - 2, '#0d1117');
  const row = (label, win, ry) => {
    const left = remaining(win);
    text(label, x + 2, ry + 2.6, 2.6, C.metal, 'left');
    R(x + 8, ry, 11, 3, C.chair);
    if (left != null) R(x + 8, ry, (11 * left) / 100, 3, fuelColor(left));
    text(left == null ? '–' : `${left}%`, x + w - 1.5, ry + 2.6, 2.6, fuelColor(left), 'right');
  };
  row('5h', state.limits?.fiveHour, y + 3);
  row('7d', state.limits?.week, y + 9);
}


/** Digital wall clock: HH:MM:SS + weekday and date, LED style. (x, y) = top-left corner. */
export function drawClock(x, y, date) {
  const w = 28;
  const h = 15;
  R(x, y, w, h, C.trim);
  R(x + 1, y + 1, w - 2, h - 2, '#0d1117');
  R(x + 1, y + 1, w - 2, 0.5, '#262b44');
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const day = `${WEEKDAYS[date.getDay()]} ${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`;
  text(time, x + w / 2, y + 7, 4, C.red);
  text(day, x + w / 2, y + 12.3, 2.6, C.teal);
}


export function personNearDoor() {
  for (const w of workers.values()) {
    if (Math.hypot(w.x - DOOR.x, w.y - DOOR.y) < 12) return true;
    if (w.interns.some((i) => Math.hypot(i.x - DOOR.x, i.y - DOOR.y) < 12)) return true;
  }
  return false;
}


/** Tiled floor in a rectangle: `a`/`b` alternate per tile, `seam` lines between tiles. */
function floor(x, y, w, h, tile, a, b, seam) {
  R(x, y, w, h, a);
  for (let ty = 0; ty * tile < h; ty++) {
    for (let tx = 0; tx * tile < w; tx++) {
      if ((tx + ty) % 2) R(x + tx * tile, y + ty * tile, Math.min(tile, w - tx * tile), Math.min(tile, h - ty * tile), b);
    }
  }
  if (!seam) return;
  for (let yy = y; yy < y + h; yy += tile) R(x, yy, w, 0.5, seam);
  for (let xx = x; xx < x + w; xx += tile) R(xx, y, 0.5, h, seam);
}


/** Company sign above the reception – a made-up brand. */
export function drawLogo(x, y) {
  R(x, y, 58, 13, C.trim);
  R(x + 1, y + 1, 56, 11, C.paper);
  // paper stack icon
  R(x + 3, y + 3, 7, 7, C.white);
  R(x + 4, y + 2, 7, 7, '#d7d3c4');
  R(x + 5, y + 1.5, 6, 6.5, C.white);
  R(x + 9, y + 1.5, 2, 2, C.blue);
  text('PAPÍRNA SVIŠŤ', x + 34, y + 6.4, 3.4, C.ink);
  text('pobočka', x + 34, y + 10.6, 2.4, C.metalDark);
}


export function drawRoom(t, date) {
  // floors: carpet tiles in the bullpen, darker carpet in the glass rooms, linoleum by the kitchen and in the break room
  floor(0, FLOOR_Y, W, H - FLOOR_Y, 12, C.carpetA, C.carpetB, null);
  floor(0, FLOOR_Y, 151, GLASS_Y - FLOOR_Y + 4, 8, C.roomA, C.roomB, null);
  floor(152, FLOOR_Y, W - 152, 54, 8, C.linoA, C.linoB, C.linoSeam);
  floor(196, 100, W - 196, H - 100, 8, C.linoA, C.linoB, C.linoSeam);
  // break room rug
  R(226, 106, 90, 70, C.rugEdge);
  R(228, 108, 86, 66, C.rug);
  for (let i = 0; i < 6; i++) R(232 + i * 14, 112, 6, 1, C.rugEdge);

  // back wall; trims where the glass rooms meet it
  R(0, 0, W, 46, C.wall);
  R(0, 0, W, 2, C.trim);
  R(0, 30, W, 1, C.wallLight);
  R(0, 44, W, 2, C.trim);
  R(0, 2, 151, 28, C.wallRoom);

  const sky = skyFor(hourOf(date));
  // manager's office: employee of the week, window
  drawPortrait(t);
  drawWindow(30, 8, 28, 20, sky, t);
  // conference room: whiteboard + window
  drawWindow(116, 8, 30, 20, sky, t);

  // whiteboard: today's finished tasks / plan-mode meeting diagram / strike notice
  const bx = 70;
  R(bx, 7, 40, 26, C.metalDark);
  R(bx + 1, 8, 38, 24, C.white);
  const meeting = [...workers.values()].some((w) => w.place === 'board');
  if (strikeActive()) {
    text('STÁVKA', bx + 20, 17, 5.5, C.red);
    text('došly tokeny', bx + 20, 23, 3, C.metalDark);
    text(`do ${fmtReset(strikeUntil > Date.now() ? strikeUntil : state.limits?.fiveHour?.resetsAt) || '?'}`, bx + 20, 28.5, 3, C.metalDark);
  } else if (meeting) {
    drawDiagram(bx + 1, 8, t);
    text(`✓ ${stats.done}`, bx + 37.5, 30.5, 2.6, C.green, 'right');
  } else {
    text('HOTOVO DNES', bx + 20, 14, 3.2, C.metalDark);
    text(String(stats.done), bx + 20, 26, 9, C.green);
  }
  R(bx + 2, 33, 36, 1.5, C.metal);
  R(bx + 8, 32, 3, 1, C.red);
  R(bx + 13, 32, 3, 1, C.blue);

  // side walls of the glass rooms (seen edge-on)
  for (const x of [63, 148]) {
    R(x, 24, 4, GLASS_Y - 24, C.glass);
    R(x, 24, 1, GLASS_Y - 24, C.glassFrame);
    R(x + 3, 24, 1, GLASS_Y - 24, C.glassFrame);
    R(x, 23, 4, 1.2, C.glassFrame);
  }

  // manager's office: filing cabinet
  R(50, 30, 12, 24, C.metalDark);
  for (let i = 0; i < 3; i++) {
    R(51, 31 + i * 7.5, 10, 6.5, C.metal);
    R(54, 33.5 + i * 7.5, 4, 1, C.metalDark);
  }

  // kitchenette: vending machine, counter, coffee machine, microwave, fruit, water cooler
  R(153, 10, 14, 40, C.red);
  R(154, 12, 9, 26, C.night);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) R(155 + c * 2.8, 13.5 + r * 6, 2, 3, [C.yellow, C.lime, C.orange, C.teal][(r + c) % 4]);
  R(164, 14, 2, 8, C.metal);
  R(154, 40, 9, 4, C.ink);
  R(153, 10, 14, 1.5, shade(C.red, 0.25));

  R(170, 30, 42, 3, C.paper);
  R(170, 33, 42, 13, C.deskEdge);
  for (let i = 0; i < 3; i++) {
    R(171.5 + i * 13.5, 35, 12, 9, C.deskFront);
    R(176 + i * 13.5, 39, 3, 1, C.deskTop);
  }
  R(172, 16, 12, 14, C.ink);
  R(173, 17, 10, 4, C.chair);
  R(181, 18, 1.5, 1.5, Math.floor(t * 2) % 2 ? C.red : C.green);
  R(176, 22, 4, 2, C.metal);
  R(176, 26, 4, 4, C.white);
  R(187, 21, 15, 9, C.metal);
  R(188, 22, 9, 7, C.ink);
  R(199, 23, 2, 1, C.green);
  R(203, 27, 8, 3, C.white);
  R(203.5, 25, 2.5, 2.5, C.red);
  R(206, 25, 2.5, 2.5, C.yellow);
  R(208.5, 26, 2.5, 2.5, C.lime);

  R(214, 24, 8, 22, C.white);
  R(214, 44, 8, 2, C.metal);
  R(215, 13, 6, 11, '#73eff7cc');
  R(216, 14, 1.5, 8, '#ffffff88');
  R(216, 30, 2, 2, C.blue);
  R(219, 30, 2, 2, C.red);

  // reception wall: company sign, clock, limits
  drawLogo(226, 2);
  drawClock(226, 17, date);
  drawLimits(256, 17);

  // entrance
  R(288, 12, 20, 34, C.trim);
  if (personNearDoor()) {
    R(290, 14, 16, 32, C.night);
    R(290, 14, 3, 32, C.deskEdge);
  } else {
    R(290, 14, 16, 32, C.deskEdge);
    R(292, 16, 12, 12, C.deskFront);
    R(292, 30, 12, 13, C.deskFront);
    R(302, 29, 2, 2, C.yellow);
  }
  text('EXIT', 298, 10.5, 3, C.lime);

  // plants
  plant(6, 54);
  plant(143, 56);
  plant(312, 176);
  plant(200, 178);

  // break room: TV (sofa is depth-sorted in front of its sitters)
  const watching = [...workers.values()].some((w) => w.idle?.kind === 'sofa' && w.idle.arrived);
  drawTV(t, watching);
  // floor lamp
  R(309, 110, 2, 26, C.metalDark);
  R(305, 106, 10, 5, C.yellow);
  R(306, 136, 8, 2, C.metalDark);
}
