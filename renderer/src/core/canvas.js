/** Canvas, logical 320×180 coordinate system and pixel drawing primitives. */

export const W = 320;

export const H = 180;

export const COMPACT = new URLSearchParams(location.search).get('mode') === 'compact';

export const canvas = document.getElementById('scene');

export const ctx = canvas.getContext('2d');

export let S = 1;

export let OX = 0;

export let OY = 0;

export let DPR = 1;


export function resize() {
  DPR = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * DPR));
  canvas.height = Math.max(1, Math.round(r.height * DPR));
  S = Math.min(canvas.width / W, canvas.height / H);
  OX = Math.round((canvas.width - W * S) / 2);
  OY = Math.round((canvas.height - H * S) / 2);
}

// the canvas also changes size without the window (conversation panel opening next to it)
new ResizeObserver(resize).observe(canvas);

resize();


/** Filled rect in logical pixels, snapped to device pixels (no seams at any scale). */
export function R(x, y, w, h, color) {
  const x0 = Math.round(OX + x * S);
  const y0 = Math.round(OY + y * S);
  const x1 = Math.round(OX + (x + w) * S);
  const y1 = Math.round(OY + (y + h) * S);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}


export const font = (size) => `${Math.max(1, Math.round(size * S))}px Menlo, Monaco, monospace`;


export function text(str, x, y, size, color, align = 'center') {
  ctx.font = font(size);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(str, OX + x * S, OY + y * S);
}


export function measure(str, size) {
  ctx.font = font(size);
  return ctx.measureText(str).width / S;
}


export function truncate(str, max) {
  const chars = [...String(str)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}


export function toLogical(e) {
  const rect = canvas.getBoundingClientRect();
  return [((e.clientX - rect.left) * DPR - OX) / S, ((e.clientY - rect.top) * DPR - OY) / S];
}
