/**
 * The conversation list in the panel next to the office: every Claude conversation on this machine (AI Office's own,
 * Claude desktop's, terminal ones) grouped by project, with search, the archive, renaming. Click = open.
 */
import { html, useEffect, useRef, useState } from './lib.js';
import { archiveChat, chat, clearError, hidePanel, openChat, openModal, renameChat, setQuery, showArchive } from './store.js';

const GROUPS_KEY = 'ai-office:groups';
const PER_GROUP = 8;

/** Conversations from elsewhere: icon and where they come from. */
export const SOURCES = {
  desktop: ['🖥', 'Claude desktop'],
  cli: ['⌨', 'terminál'],
  sdk: ['🤖', 'SDK'],
  other: ['?', 'jiná aplikace'],
};

export function ago(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'teď';
  if (min < 60) return `před ${min} min`;
  if (min < 24 * 60) return `před ${Math.round(min / 60)} h`;
  if (min < 30 * 24 * 60) return `před ${Math.round(min / 1440)} d`;
  return new Date(ts).toLocaleDateString('cs-CZ');
}

/** Icon, legend (tooltip) and class of a conversation's state. */
function statusIcon(s) {
  if (s.busy) return ['⚙', 'pracuje', 'busy'];
  if (s.running) return ['●', 'v kanceláři – session běží', 'running'];
  if (s.managed !== false) return ['○', 'z kanceláře – session neběží, na zprávu se vrátí', ''];
  const [icon, label] = SOURCES[s.source] ?? SOURCES.other;
  return [icon, `${label} – odpověď vytvoří kopii v kanceláři`, 'foreign'];
}

/** Lower case without diacritics. */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const plural = (n) => `${n} ${n >= 1 && n <= 4 ? 'konverzace' : 'konverzací'}`;

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

/** Inline title editor: Enter saves ('' = back to the automatic title), Esc or clicking away cancels. */
export function TitleEdit({ value, onSave, onCancel }) {
  const [text, setText] = useState(value ?? '');
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(text.trim());
    else onCancel();
  };
  const onKey = (e) => {
    e.stopPropagation(); // Esc must not close the panel, ⌘K not leave
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  return html`<input ref=${ref} class="rename" value=${text} maxlength="120" placeholder="prázdné = automatický název"
    title="Enter uloží, Esc zruší; prázdné = automatický název"
    onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onKey} onClick=${(e) => e.stopPropagation()} onBlur=${() => finish(false)} />`;
}

function Row({ s, snippet, editing, setEditing }) {
  const [icon, legend, cls] = statusIcon(s);
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  return html`<div class=${`conv${editing ? ' editing' : ''}`} onClick=${() => { if (!editing) openChat(s.id); }}>
    <span class=${`st ${cls}`} title=${legend}>${icon}</span>
    <div class="main">
      ${editing
        ? html`<${TitleEdit} value=${s.title} onSave=${(t) => { setEditing(null); if (t !== s.title) renameChat(s.id, t); }} onCancel=${() => setEditing(null)} />`
        : html`<div class="t" title=${s.owner ? `${s.title || 'Bez názvu'}\nVlastník: ${s.owner.name}` : s.title}>${s.title || 'Bez názvu'}</div>`}
      ${snippet ? html`<div class="snip">${snippet}</div>` : null}
    </div>
    <span class="when" title=${s.lastActive ? new Date(s.lastActive).toLocaleString('cs-CZ') : ''}>${ago(s.lastActive)}</span>
    ${editing ? null : html`<span class="acts">
      <button title="Přejmenovat" onClick=${stop(() => setEditing(s.id))}>✎</button>
      <button title=${s.archived ? 'Obnovit z archivu' : 'Archivovat'} onClick=${stop(() => archiveChat(s.id, !s.archived))}>${s.archived ? '📤' : '📥'}</button>
    </span>`}
  </div>`;
}

function emptyText(q) {
  if (!chat.listed) return 'Načítám konverzace…';
  if (q) return 'Nic nenalezeno.';
  if (chat.archived) return 'Archiv je prázdný. Konverzaci archivuješ ikonou 📥 u jejího řádku.';
  return 'Zatím žádné konverzace. Zadej první úkol přes ＋ Nový úkol (⌘N) – objeví se tu i konverzace z Claude desktopu a terminálu.';
}

export function ConversationList() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [expanded, setExpanded] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const search = useRef(null);
  useEffect(() => { search.current?.focus(); }, [chat.focusSearch]);

  const words = fold(chat.query).split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const all = [...chat.sessions.values()].filter((s) => Boolean(s.archived) === chat.archived);
  const shown = searching ? all.filter((s) => chat.hits?.has(s.id) || words.every((w) => fold(`${s.title} ${s.project}`).includes(w))) : all;
  shown.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  // by project; a project's place is its most recent conversation
  const groups = new Map();
  for (const s of shown) {
    const key = s.projectPath || s.cwd || s.project || '?';
    if (!groups.has(key)) groups.set(key, { key, label: s.project || key, list: [] });
    groups.get(key).list.push(s);
  }
  const toggle = (key) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
    } catch { /* storage unavailable */ }
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && chat.query) {
      e.stopPropagation(); // first Esc clears the search, the next one hides the panel
      setQuery('');
    } else if (e.key === 'Enter' && !e.isComposing && shown[0]) {
      e.preventDefault();
      openChat(shown[0].id);
    }
  };
  const busy = all.filter((s) => s.busy).length;
  return html`<div class="panel convs">
    <header>
      <div class="title">
        <div class="task">💬 Konverzace</div>
        <div class="status">${chat.archived ? `📥 archiv · ${plural(all.length)}` : `${plural(all.length)}${busy ? ` · ${busy} v práci` : ''}`}</div>
      </div>
      <div class="buttons">
        <button class="primary" onClick=${() => openModal('new')} title="Nový úkol (⌘N)">＋ Nový úkol</button>
        <button class="close" onClick=${hidePanel} title="Schovat panel (Esc)">✕</button>
      </div>
    </header>
    <div class="conv-tools">
      <input ref=${search} class="search" type="search" value=${chat.query} placeholder="Hledat v názvech a zprávách… (⌘K)"
        onInput=${(e) => setQuery(e.currentTarget.value)} onKeyDown=${onKey} />
      <button class=${chat.archived ? 'active' : ''} onClick=${() => showArchive(!chat.archived)} title="Ukázat jen archivované konverzace">📥 Archiv</button>
    </div>
    <div class="items">
      ${chat.error ? html`<div class="notice error panel-error"><span>${chat.error}</span><button class="close" onClick=${clearError} title="Zavřít">✕</button></div>` : null}
      ${shown.length ? [...groups.values()].map((g) => {
        const closed = !searching && collapsed.has(g.key);
        const open = expanded.has(g.key);
        const rows = closed ? [] : open ? g.list : g.list.slice(0, PER_GROUP);
        const rest = g.list.length - PER_GROUP;
        return html`<div class="conv-group" key=${g.key}>
          <div class="g" title=${g.key} onClick=${() => toggle(g.key)}>
            <span class="arr">${closed ? '▸' : '▾'}</span> ${g.label} <span class="n">${g.list.length}</span>
          </div>
          ${rows.map((s) => html`<${Row} key=${s.id} s=${s} snippet=${searching ? chat.hits?.get(s.id) : null} editing=${editing === s.id} setEditing=${setEditing} />`)}
          ${!closed && rest > 0 ? html`<button class="more" onClick=${() => {
            const next = new Set(expanded);
            if (open) next.delete(g.key);
            else next.add(g.key);
            setExpanded(next);
          }}>${open ? 'méně' : `+${rest} ${rest === 1 ? 'další' : rest <= 4 ? 'další' : 'dalších'}`}</button>` : null}
        </div>`;
      }) : html`<div class="empty">${emptyText(searching)}</div>`}
    </div>
  </div>`;
}
