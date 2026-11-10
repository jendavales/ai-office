/** Base walking character (path following, speech bubbles). */
import { now, rand } from '../core/util.js';
import { DOOR, SPEED, route } from '../world/layout.js';

/** Ghosts float slowly and straight through walls and furniture. */
export const GHOST_SPEED = 26;

export class Person {
  constructor(look) {
    this.look = look;
    this.x = DOOR.x;
    this.y = DOOR.y - 6;
    this.speed = SPEED * rand(0.85, 1.15); // everyone walks at their own pace
    this.path = [];
    this.facing = 'down';
    this.step = 0;
    this.onArrive = null;
    this.bubble = null;
  }

  get walking() {
    return this.path.length > 0;
  }

  /** `opts` go to the path finder (see world/path.js findPath), e.g. `{ detour: 0 }` for short indoor walks. */
  walkTo(loc, onArrive, opts) {
    this.path = route({ x: this.x, y: this.y }, loc, opts);
    this.onArrive = onArrive ?? null;
  }

  placeAt(loc) {
    this.x = loc.x;
    this.y = loc.y;
    this.path = [];
  }

  say(str, secs = 3, kind = 'info') {
    if (!str) return;
    this.bubble = { text: str, until: now() + secs * 1000, kind };
  }

  move(dt) {
    let budget = (this.ghost ? GHOST_SPEED : this.speed) * dt;
    while (budget > 0 && this.path.length) {
      const p = this.path[0];
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.x = p.x;
        this.y = p.y;
        budget -= d;
        this.path.shift();
      } else {
        this.x += (dx / d) * budget;
        this.y += (dy / d) * budget;
        this.facing = Math.abs(dy) > Math.abs(dx) && dy < 0 ? 'up' : 'down';
        budget = 0;
      }
    }
    if (this.path.length) {
      this.step += dt * 8;
    } else if (this.onArrive) {
      const cb = this.onArrive;
      this.onArrive = null;
      cb();
    }
    if (this.bubble && now() > this.bubble.until) this.bubble = null;
  }
}
