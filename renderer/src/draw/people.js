/** Drawing employees, interns and the director according to their state. */
import { now } from '../core/util.js';
import { chairBack, figure as drawFigure, ghostFigure } from './figure.js';
import { EMOTIONS, moodSpeed } from '../entities/mood.js';
import { WORKING } from '../entities/activity.js';

export const SEATED_ARMS = {
  typing: 'type', terminal: 'type', planning: 'type', reading: 'mouse', web: 'mouse',
  thinking: 'think', waiting: 'raise', phone: 'phone', sleeping: 'rest', idle: 'down', surfing: 'mouse',
};


export function drawWorker(w, t) {
  const look = w.look;
  if (w.ghost) {
    ghostFigure(w.x, w.y, look, t);
    return;
  }
  // mood: facial expression (front view) and animation tempo
  const emotion = w.mood.current;
  const mood = { face: EMOTIONS[emotion].face, speed: moodSpeed(w) };
  const figure = (x, y, lk, pose, k) => drawFigure(x, y, lk, { ...mood, ...pose }, k);
  const celebrating = (emotion === 'happy' || emotion === 'proud') && w.mood.flash?.until > now();
  if (w.walking) {
    figure(w.x, w.y, look, { view: w.facing === 'up' ? 'back' : 'front', walking: w.step, arms: 'down', t });
    return;
  }
  const oops = w.errorUntil > now();
  if (w.place === 'board') {
    figure(w.x, w.y, look, { view: 'back', arms: w.waiting ? 'raise' : oops ? 'facepalm' : 'draw', t });
    return;
  }
  if (w.place === 'desk' && w.seat.desk) {
    const animate = ['typing', 'terminal', 'planning'].includes(w.activity);
    const arms = oops && !w.waiting ? 'facepalm'
      : celebrating && !w.waiting ? 'cheer'
        : SEATED_ARMS[w.activity] ?? 'down';
    const shake = emotion === 'frustrated' && animate ? Math.sin(t * 25) * 0.4 : 0;
    figure(w.x + shake, w.y, look, {
      view: 'back', seated: true, arms, animate, t,
      headDrop: w.activity === 'sleeping' ? 2 : emotion === 'tired' ? 1 : 0,
    });
    chairBack(w.x, w.y, true);
    return;
  }
  if (w.place === 'desk' && w.seat.sofa) {
    // overflow seat: works on a laptop on the sofa (seen from behind, sofa back drawn over)
    figure(w.x, w.y, look, { view: 'back', seated: true, arms: WORKING.has(w.activity) ? 'type' : 'down', animate: WORKING.has(w.activity), t });
    return;
  }
  if (w.place === 'desk' && w.seat.standing) {
    figure(w.x, w.y, look, { view: 'front', arms: 'laptop', animate: WORKING.has(w.activity), t });
    return;
  }
  if (w.place === 'spot' && w.idle) {
    switch (w.idle.kind) {
      case 'coffee':
        figure(w.x, w.y, look, { view: 'front', arms: 'mug', t });
        return;
      case 'sofa': {
        const laugh = w.bubble && Math.floor(t * 6) % 2 ? -0.5 : 0;
        figure(w.x, w.y + laugh, look, { view: 'back', seated: true, arms: 'down', t });
        return;
      }
      case 'window':
        figure(w.x, w.y, look, { view: 'back', arms: 'down', t });
        return;
      case 'chat':
        figure(w.x, w.y, look, { view: 'front', arms: w.talkingUntil > now() ? 'talk' : 'down', t });
        return;
      default:
        break;
    }
  }
  figure(w.x, w.y, look, { view: 'front', arms: 'down', t });
}


export function drawIntern(i, t) {
  if (i.walking) {
    drawFigure(i.x, i.y, i.look, { view: i.facing === 'up' ? 'back' : 'front', walking: i.step, arms: 'down', t }, 0.8);
    return;
  }
  drawFigure(i.x, i.y, i.look, { view: 'front', arms: 'laptop', animate: true, t: t + i.slot }, 0.8);
}


/**
 * The director walks about the glass office: strolls and looks around (facing the room), paces on the phone,
 * rummages in the filing cabinet or writes on the task board (at a spot: seen from behind, hands busy).
 */
export function drawDirector(d, t) {
  const beat = d.beat;
  if (d.walking) {
    drawFigure(d.x, d.y, d.look, { view: d.facing === 'up' ? 'back' : 'front', walking: d.step, arms: beat?.kind === 'phone' ? 'phone' : 'down', face: d.face, t });
    return;
  }
  if (beat?.spot) {
    drawFigure(d.x, d.y, d.look, { view: 'back', arms: beat.arms, animate: true, t });
    return;
  }
  drawFigure(d.x, d.y, d.look, { view: 'front', arms: beat?.arms ?? 'down', face: d.face, t });
}
