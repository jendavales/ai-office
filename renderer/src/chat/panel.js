/** Conversation panel next to the office: one employee's session – messages, tool calls, your next message. */
import { state, workers } from '../state.js';
import { html, markdown, useEffect, useLayoutEffect, useMemo, useRef, useState } from './lib.js';
import { chat, closeChat } from './store.js';

const TOOL_ICONS = [
  [/^(Bash|BashOutput|KillShell|KillBash|Monitor)$/, '⌨'],
  [/^(Read|NotebookRead|LS)$/, '📖'],
  [/^(Grep|Glob)$/, '🔍'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, '✏️'],
  [/^Web/, '🌐'],
  [/^(Agent|Task)$/, '🧑‍🎓'],
  [/^(TodoWrite|ExitPlanMode|EnterPlanMode)$/, '📋'],
  [/^mcp__/, '📞'],
];
const toolIcon = (name) => TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? '🔧';
const STATUS = { run: '…', ok: '✓', err: '✕', stop: '–' };

const seconds = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

function Markdown({ text, live }) {
  const htmlText = useMemo(() => markdown(text), [text]);
  return html`<div class=${`md${live ? ' live' : ''}`} dangerouslySetInnerHTML=${{ __html: htmlText }} />`;
}

function Item({ item }) {
  switch (item?.kind) {
    case 'user':
      return html`<div class="msg user"><div class="who">Ty</div><div class="body">${item.text}</div></div>`;
    case 'text':
      return html`<div class="msg claude"><${Markdown} text=${item.text} live=${!item.done} /></div>`;
    case 'tool':
      return html`<div class=${`tool ${item.status}`} title=${`${item.name} ${item.label}`}>
        <span class="ico">${toolIcon(item.name)}</span><span class="name">${item.name.replace(/^mcp__/, '')}</span>
        <span class="label">${item.label === item.name ? '' : item.label}</span><span class="st">${STATUS[item.status] ?? ''}</span>
      </div>`;
    case 'notice':
      return html`<div class=${`notice ${item.tone}`}>${item.text}</div>`;
    case 'done': {
      const parts = [item.error ? `✕ ${item.error}` : '✓ hotovo'];
      if (item.ms != null) parts.push(seconds(item.ms));
      return html`<div class=${`turn-end${item.error ? ' error' : ''}`}>${parts.join(' · ')}</div>`;
    }
    default:
      return null;
  }
}

function statusLine(s, w) {
  if (!s) return '';
  if (s.busy) return `⚙ ${s.activity || 'pracuje…'}`;
  if (w?.waiting) return '🙋 čeká na tvoje povolení';
  if (!s.running) return s.summary ? `💤 ${s.summary}` : '💤 doma – napiš a vrátí se do kanceláře';
  return s.summary ? `✓ ${s.summary}` : '✓ čeká na tebe';
}

function Composer({ id, busy }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, [id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const send = () => {
    if (!text.trim()) return;
    window.office.chat.send(id, text);
    setText('');
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return html`<div class="composer">
    <textarea ref=${ref} rows="1" value=${text} onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onKey}
      placeholder=${busy ? 'Další zpráva – přijde na řadu, až Claude dokončí tuhle' : 'Napiš zprávu… (Enter odešle, Shift+Enter nový řádek)'} />
    <div class="actions">
      ${busy ? html`<button class="stop" onClick=${() => window.office.chat.stop(id)} title="Přerušit práci">■ Zastavit</button>` : null}
      <button class="primary" disabled=${!text.trim()} onClick=${send}>Odeslat</button>
    </div>
  </div>`;
}

export function Panel() {
  const id = state.chatOpen;
  const s = id ? chat.sessions.get(id) : null;
  const items = (id && chat.items.get(id)) || [];
  const w = id ? workers.get(id) : null;
  const list = useRef(null);
  const pinned = useRef(true); // follow the conversation unless you scrolled up to read
  const onScroll = () => {
    const el = list.current;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useLayoutEffect(() => { pinned.current = true; }, [id]);
  useLayoutEffect(() => {
    if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  });
  if (!s) return null;

  const who = w?.displayName ?? w?.name;
  const onClick = (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    window.office.openExternal(a.href);
  };
  return html`<div class="panel">
    <header>
      <div class="title">
        <div class="name">${who ? html`<b>${who}</b> · ` : ''}${s.project}</div>
        <div class="task" title=${s.cwd}>${s.title || 'Nový úkol'}</div>
        <div class=${`status${s.busy ? ' busy' : ''}`}>${statusLine(s, w)}</div>
      </div>
      <div class="buttons">
        ${s.running && !s.busy ? html`<button onClick=${() => window.office.chat.dismiss(id)} title="Ukončit session – konverzaci můžeš kdykoli dál psát">🏠 Domů</button>` : null}
        <button class="close" onClick=${closeChat} title="Zavřít (Esc)">✕</button>
      </div>
    </header>
    <div class="items" ref=${list} onScroll=${onScroll} onClick=${onClick}>
      ${items.length ? items.map((item, i) => html`<${Item} key=${i} item=${item} />`) : html`<div class="empty">Konverzace je zatím prázdná.</div>`}
      ${s.busy ? html`<div class="working">${who ?? 'Claude'} pracuje<span class="dots" /></div>` : null}
    </div>
    <${Composer} id=${id} busy=${s.busy} />
  </div>`;
}
