/**
 * Conversation UI: the panel next to the office (a conversation, the director's to-do list, or else the list of
 * conversations), the new task and rewind dialogs, bar buttons and shortcuts (⌘N new task, ⌘K the list and its
 * search, Esc: dialog → conversation back to the list → to-do list → hide the panel).
 * Not in the menu-bar popover – there a click opens the main window.
 */
import { COMPACT } from '../core/canvas.js';
import { state } from '../state.js';
import { Dialogs } from './dialogs.js';
import { html, render } from './lib.js';
import { ConversationList } from './list.js';
import { Panel } from './panel.js';
import { chat, closeChat, closeModal, hidePanel, loadOptions, openModal, refreshList, showList, subscribe } from './store.js';
import { TodoPanel } from '../todo/panel.js';
import { closeTodos } from '../todo/store.js';

const panelEl = document.getElementById('chat');
const modalEl = document.getElementById('modal');
const actionsEl = document.getElementById('bar-actions');

const listShown = () => state.panelOpen && !state.chatOpen && !state.todosOpen;

/** The list of conversations in the panel – instead of an open conversation or the to-do list. */
function toList(focus = false) {
  if (state.todosOpen) closeTodos();
  showList({ focus });
}

function BarActions() {
  return html`
    <button class=${listShown() ? 'active' : ''} onClick=${() => (listShown() ? hidePanel() : toList())} title="Seznam konverzací (⌘K)">💬 Konverzace</button>
    <button class="primary" onClick=${() => openModal('new')} title="Nový úkol (⌘N)">＋ Nový úkol</button>`;
}

function draw() {
  panelEl.hidden = !state.chatOpen && !state.todosOpen && !state.panelOpen;
  render(state.todosOpen ? html`<${TodoPanel} />` : state.chatOpen ? html`<${Panel} />` : html`<${ConversationList} />`, panelEl);
  render(html`<${Dialogs} />`, modalEl);
  render(html`<${BarActions} />`, actionsEl);
}

export function setupChat() {
  if (!window.office?.chat) return;
  refreshList();
  if (COMPACT) return;
  loadOptions();
  subscribe(draw);
  draw();
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openModal('new');
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      closeModal();
      if (!chat.modal) toList(true);
    } else if (e.key === 'Escape' && !e.isComposing) {
      if (!document.getElementById('stats').hidden) return; // the statistics panel closes first
      if (chat.modal) closeModal();
      else if (state.chatOpen) closeChat();
      else if (state.todosOpen) closeTodos();
      else if (state.panelOpen) hidePanel();
    }
  });
}
