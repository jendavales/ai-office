/**
 * Conversation UI: the panel next to the office, new task / switcher dialogs, bar buttons and shortcuts
 * (⌘N new task, ⌘K conversations, Esc closes). Not in the menu-bar popover – there a click opens the main window.
 */
import { COMPACT } from '../core/canvas.js';
import { state } from '../state.js';
import { Dialogs } from './dialogs.js';
import { html, render } from './lib.js';
import { Panel } from './panel.js';
import { chat, closeChat, closeModal, openModal, refreshList, subscribe } from './store.js';

const panelEl = document.getElementById('chat');
const modalEl = document.getElementById('modal');
const actionsEl = document.getElementById('bar-actions');

function BarActions() {
  return html`
    <button onClick=${() => { refreshList(); openModal('switch'); }} title="Konverzace (⌘K)">💬 Konverzace</button>
    <button class="primary" onClick=${() => openModal('new')} title="Nový úkol (⌘N)">＋ Nový úkol</button>`;
}

function draw() {
  panelEl.hidden = !state.chatOpen;
  render(html`<${Panel} />`, panelEl);
  render(html`<${Dialogs} />`, modalEl);
}

export function setupChat() {
  if (!window.office?.chat) return;
  refreshList();
  if (COMPACT) return;
  render(html`<${BarActions} />`, actionsEl);
  subscribe(draw);
  draw();
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openModal('new');
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      refreshList();
      openModal(chat.modal === 'switch' ? null : 'switch');
    } else if (e.key === 'Escape') {
      if (!document.getElementById('stats').hidden) return; // the statistics panel closes first
      if (chat.modal) closeModal();
      else if (state.chatOpen) closeChat();
    }
  });
}
