/** Entry point: wire IPC, restore state, start the loop. */
import { lookFor } from './entities/look.js';
import { Convo } from './entities/idle.js';
import { handle, restore } from './events.js';
import { frame } from './loop.js';
import { state, workers } from './state.js';
import { updateBar } from './ui/bar.js';
import { openStats, refreshStats } from './ui/stats.js';
import { CHAT_PAIRS } from './world/layout.js';
import './ui/tooltip.js'; // registers canvas mouse handlers
import { setupChat } from './chat/index.js';
import { chat, closeChat, openChat, refreshList, showList } from './chat/store.js';
import { applyTodos, openTodos, todo } from './todo/store.js';

// Handle for dev scripts (AI_OFFICE_EVAL screenshots) – modules are not globals.
window.__office = { state, workers, Convo, CHAT_PAIRS, lookFor, openStats, chat, openChat, closeChat, refreshList, showList, todo, openTodos, applyTodos };

(async () => {
  if (window.office) {
    window.office.onEvent(handle);
    window.office.onSettings((s) => { state.soundOn = s.sound; });
    window.office.onLimits((l) => { state.limits = l; updateBar(); });
    window.office.onShowStats(openStats);
    try {
      restore(await window.office.snapshot());
      const info = await window.office.info();
      state.port = info.port;
      state.soundOn = info.sound;
      state.limits = info.limits;
    } catch { /* main process not ready */ }
  }
  setupChat();
  refreshStats();
  setInterval(refreshStats, 60_000);
  setInterval(updateBar, 500);
  updateBar();
  requestAnimationFrame(frame);
})();
