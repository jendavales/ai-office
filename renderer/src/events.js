/** Office events from the main process → employee reactions. */
import { buzz, chime, ding, fanfare, pop } from './audio.js';
import { GREETINGS } from './content/texts.js';
import { hash, now, pick, rand, randItem } from './core/util.js';
import { activityFor, toolLabel } from './entities/activity.js';
import { Worker } from './entities/worker.js';
import { confetti } from './life/particles.js';
import { triggerStrike } from './limits.js';
import { bumpDone, workers } from './state.js';
import { moodEvent } from './entities/mood.js';

export function spawn(ev) {
  const w = new Worker(ev);
  workers.set(w.id, w);
  w.enter();
  return w;
}


export function handle(ev) {
  if (ev.type === 'meta') {
    const w = workers.get(ev.sessionId);
    if (w) {
      w.project = ev.project;
      w.cwd = ev.cwd;
    }
    return;
  }

  if (ev.type === 'levelUp') {
    const lw = workers.get(ev.sessionId);
    if (lw) {
      lw.setProfile(ev.profile);
      lw.say(`⭐ Povýšení: ${ev.profile.title}!`, 5, 'ok');
      moodEvent(lw, 'levelUp');
      confetti(lw.x, lw.y - 20, 50);
      fanfare();
    }
    return;
  }
  if (ev.type === 'stats') {
    workers.get(ev.sessionId)?.setStats(ev.context, ev.cost);
    return;
  }

  let w = workers.get(ev.sessionId);
  if (ev.type === 'leave') {
    w?.leave();
    return;
  }
  if (w?.leaving) return;
  if (!w) {
    w = spawn(ev);
    if (ev.type === 'join') w.say(pick(GREETINGS, hash(w.id)), 3);
  }
  if (ev.project && !w.project.includes('·')) w.project = ev.project;
  if (ev.name) w.name ??= ev.name;
  if (ev.profile) w.setProfile(ev.profile);
  if (ev.mode) w.setMode(ev.mode);

  switch (ev.type) {
    case 'error':
      w.lastText = `💥 ${ev.tool}: ${ev.text}`;
      w.work(activityFor(ev.tool));
      w.errorUntil = now() + 3500;
      moodEvent(w, 'error');
      w.say(`💥 ${ev.text || ev.tool}`, 3.5, 'error');
      buzz();
      break;
    case 'failure':
      w.becomeFree(rand(3000, 6000));
      moodEvent(w, 'failure');
      if (ev.limit) triggerStrike();
      else w.say(`⚠️ API: ${ev.text}`, 5, 'error');
      buzz();
      break;
    case 'prompt':
      w.lastText = ev.text;
      w.work('thinking', `„${ev.text}“`, 5, 'prompt');
      break;
    case 'tool':
      w.lastText = toolLabel(ev.tool, ev.text);
      w.work(activityFor(ev.tool), w.lastText, 3);
      break;
    case 'toolDone':
      w.waiting = false;
      w.thinkAt = now() + 1200;
      if (ev.celebrate) celebrate(w, ev.celebrate);
      break;
    case 'subStart':
      w.work(w.activity === 'idle' || w.activity === 'sleeping' ? 'thinking' : w.activity);
      w.addIntern(ev.text || 'subagent');
      break;
    case 'subStop':
      w.removeIntern();
      break;
    case 'waiting':
      w.work('waiting');
      w.waiting = true;
      w.lastText = ev.text;
      w.say('Potřebuju povolení!', 3600, 'alert');
      moodEvent(w, 'waiting');
      ding();
      break;
    case 'done':
      w.becomeFree(rand(4000, 8000));
      w.say('Hotovo ✓', 4, 'ok');
      moodEvent(w, 'done', { workMs: ev.workMs });
      bumpDone();
      chime();
      break;
    case 'idle':
      if (!w.isFree) w.becomeFree(rand(2000, 5000));
      break;
    case 'notice':
      w.say(ev.text, 4);
      break;
    default:
      break;
  }
}


/** git commit / push celebration: confetti and applause from colleagues with nothing to do. */
export function celebrate(w, kind) {
  w.say(kind === 'push' ? '🚀 Push!' : '🎉 Commit!', 3, 'ok');
  moodEvent(w, 'celebrate');
  confetti(w.x, w.y - 20, kind === 'push' ? 45 : 30);
  pop();
  let delay = 400;
  for (const other of workers.values()) {
    if (other === w || !other.isFree || other.walking) continue;
    setTimeout(() => other.say(randItem(['👏', '👏 Paráda!', '🙌']), 2, 'chat'), delay);
    delay += 350;
  }
}


export function restore(sessions) {
  for (const s of sessions) {
    // live events may arrive before the snapshot does – those sessions already exist
    if (workers.has(s.id)) continue;
    const w = new Worker({ sessionId: s.id, name: s.name, source: s.source, cwd: s.cwd, project: s.project, profile: s.profile, mode: s.mode, coverFor: s.coverFor });
    workers.set(w.id, w);
    w.placeAt(w.seat);
    w.place = 'desk';
    w.lastText = s.text || '';
    w.context = s.context;
    w.cost = s.cost;
    w.activity = s.status === 'working' ? activityFor(s.tool || '') : 'idle';
    if (s.waiting) {
      w.activity = 'waiting';
      w.waiting = true;
      w.say('Potřebuju povolení!', 3600, 'alert');
    } else if (s.status !== 'working') {
      w.becomeFree(rand(1000, 6000));
    }
    for (let i = 0; i < s.subagents; i++) w.addIntern('subagent');
    for (const intern of w.interns) {
      intern.placeAt(intern.spot());
      intern.onArrive = null;
      intern.arrived = true;
    }
  }
}
