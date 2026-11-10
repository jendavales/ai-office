/** Speech bubbles, name tags and indicators drawn above the scene. */
import { H, OX, OY, R, S, W, ctx, measure, text, truncate } from '../core/canvas.js';
import { C } from '../core/palette.js';
import { clamp } from '../core/util.js';
import { WORKING } from '../entities/activity.js';
import { director } from '../entities/director.js';
import { strikeActive } from '../limits.js';
import { state, workers } from '../state.js';
import { TASK_BOARD } from '../world/layout.js';
import { EMOTIONS, showEmote } from '../entities/mood.js';

export const BUBBLE_STYLE = {
  info: { bg: C.white, fg: C.ink },
  prompt: { bg: '#fff5c2', fg: C.ink },
  alert: { bg: C.red, fg: C.white },
  ok: { bg: C.green, fg: C.white },
  chat: { bg: '#d6f0ff', fg: C.ink },
  error: { bg: C.orange, fg: C.white },
};


export function bubble(x, bottom, str, kind = 'info', size = 4) {
  const style = BUBBLE_STYLE[kind] ?? BUBBLE_STYLE.info;
  const label = truncate(str, kind === 'prompt' ? 30 : 24);
  const pad = 2;
  const w = Math.ceil(measure(label, size)) + pad * 2;
  const h = size + pad * 2 - 0.5;
  const bx = clamp(Math.round(x - w / 2), 1, W - w - 1);
  const by = Math.round(bottom - h - 2);
  R(bx - 0.5, by - 0.5, w + 1, h + 1, C.ink);
  R(bx, by, w, h, style.bg);
  R(x - 1.5, by + h, 3, 1.5, C.ink);
  R(x - 1, by + h, 2, 1, style.bg);
  text(label, bx + w / 2, by + pad + size * 0.82, size, style.fg);
}


export function nameTag(x, y, label, color, selected = false) {
  const size = 3;
  const str = truncate(label, 22);
  const w = Math.ceil(measure(str, size)) + 5;
  const bx = clamp(Math.round(x - w / 2), 1, W - w - 1);
  if (selected) R(bx - 0.5, y - 0.5, w + 1, 5.5, C.yellow); // whose conversation is open
  R(bx, y, w, 4.5, 'rgba(20,22,42,0.85)');
  R(bx + 1, y + 1.5, 1.5, 1.5, color);
  text(str, bx + 3 + (w - 3) / 2, y + 3.6, size, C.white);
}


/**
 * The director: name tag above the head (at the feet it would sit under the bubbles of the desks below
 * the office), highlighted while the to-do panel is open; bubble above the tag. Standing at a spot with
 * the back to the room, the tag drops to the feet, and at the task board the bubble goes above the board,
 * so neither covers the notes. The amount of tasks is on the task board (draw/taskboard.js).
 */
function drawDirectorOverlay() {
  const spot = director.walking ? null : director.beat?.spot;
  nameTag(director.x, spot ? director.y + 2.5 : director.y - 27, director.name, C.yellow, state.todosOpen);
  if (director.bubble) bubble(director.x, spot === 'board' ? TASK_BOARD.y - 2 : director.y - 29, director.bubble.text, director.bubble.kind);
}


export function drawOverlay(t) {
  drawDirectorOverlay();
  const list = [...workers.values()].filter((w) => !w.gone);
  // waiting bubbles last so they stay on top
  list.sort((a, b) => Number(a.waiting) - Number(b.waiting));

  for (const w of list) {
    const atDesk = w.place === 'desk' && !w.walking && w.seat.desk;
    const anchorY = atDesk ? w.seat.desk.deskY - 14 : w.y - 27;

    const onSofa = w.idle?.kind === 'sofa' || (w.seat.sofa && w.place === 'desk');
    const selected = w.id === state.chatOpen;
    if (selected || (!w.walking && !onSofa)) {
      const project = w.source !== 'Claude' && !w.project.includes('·') ? `${w.source} · ${w.project}` : w.project;
      const label = w.name ? `${w.name} · ${project}` : project;
      const convo = w.idle?.convo;
      nameTag(w.x, w.y + (convo && convo.b === w ? 7.5 : 2.5), label, w.look.shirt, selected);
    }

    // full context → sweating
    if (atDesk && w.context >= 75 && (WORKING.has(w.activity) || w.activity === 'thinking')) {
      const p = (t * 1.4) % 1;
      R(w.x + 5.5, w.y - 22 + p * 6, 1, 1.5, `rgba(115,239,247,${1 - p})`);
      if (w.context >= 90) R(w.x - 6.5, w.y - 21 + ((p + 0.5) % 1) * 6, 1, 1.5, `rgba(115,239,247,${1 - ((p + 0.5) % 1)})`);
    }

    // on strike: picket sign
    if (strikeActive() && w.isFree && !w.walking && (w.place === 'spot' && w.idle?.kind !== 'sofa')) {
      R(w.x + 6.5, w.y - 30, 0.8, 16, C.deskEdge);
      R(w.x + 0.5, w.y - 37, 14, 7, C.ink);
      R(w.x + 1, w.y - 36.5, 13, 6, C.white);
      text('STÁVKA', w.x + 7.5, w.y - 32.3, 2.3, C.red);
    }

    // mood emote next to the head (RPG style), bobbing gently
    const emote = EMOTIONS[w.mood.current].icon;
    if (emote && !w.ghost && !w.walking && w.activity !== 'sleeping' && showEmote(w, t)) {
      const bob = Math.sin(t * 3 + w.x) * 0.6;
      text(emote, w.x + 6.5, w.y - 23.5 + bob, 4, emote === '♪' ? C.yellow : emote === '…' ? C.white : C.teal);
    }

    if (w.extraInterns > 0 && atDesk) text(`+${w.extraInterns} 🧑‍🎓`, w.x + 24, w.y - 2, 3.5, C.lime);

    if (!w.bubble && atDesk) {
      if (w.activity === 'sleeping') {
        const p = (t * 0.8) % 1;
        text('z', w.x + 6 + p * 3, w.y - 22 - p * 6, 3 + p * 2, `rgba(244,244,244,${1 - p})`);
      } else if (w.activity === 'thinking') {
        const n = Math.floor(t * 3) % 4;
        for (let i = 0; i < n; i++) R(w.x - 3 + i * 2.5, w.y - 27, 1.5, 1.5, C.white);
      }
    }

    for (const i of w.interns) {
      if (i.bubble) bubble(i.x, i.y - 22, i.bubble.text, i.bubble.kind, 3.4);
    }
    if (w.bubble) {
      const kind = w.bubble.kind;
      const flash = kind === 'alert' && Math.floor(t * 2) % 2 === 0;
      bubble(w.x, anchorY, w.bubble.text, flash ? 'info' : kind);
    }
  }
}


export let dim = 1;

export function drawEmptyOverlay(dt) {
  const target = workers.size === 0 ? 1 : 0;
  dim += (target - dim) * Math.min(1, dt * 2);
  if (dim < 0.01) return;
  ctx.fillStyle = `rgba(8,10,24,${0.55 * dim})`;
  ctx.fillRect(OX, OY, W * S, H * S);
  ctx.globalAlpha = dim;
  text('Kancelář je prázdná', W / 2, H / 2 - 2, 8, C.white);
  text('Spusť Claude Code a někdo přijde do práce', W / 2, H / 2 + 8, 4, C.metal);
  ctx.globalAlpha = 1;
}
