/** Conversation panel next to the office: one conversation – messages, tool calls, model and effort, your next message. */
import { state, workers } from '../state.js';
import { html, markdown, useEffect, useLayoutEffect, useMemo, useRef, useState } from './lib.js';
import { SOURCES, TitleEdit, ago } from './list.js';
import {
  chat, clearError, closeChat, forkChat, hidePanel, openModal, renameChat, sendMessage, setChatOptions, setDraft,
} from './store.js';

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
// claude.ai connectors are MCP servers named by an id or a hash – the tool's own name says more
const OPAQUE_SERVER = /^(?=.*\d)[0-9a-f_-]{12,}$/i;

/** `mcp__<server>__<tool>` → „tool“ when the server is named by an id or a hash, else „server · tool“. */
function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name.replace(/^mcp__/, '');
  return OPAQUE_SERVER.test(m[1]) ? m[2] : `${m[1]} · ${m[2]}`;
}

const STATUS = { run: '…', ok: '✓', err: '✕', stop: '–' };

/** Where a conversation from elsewhere stays (after "původní zůstane v …"). */
const STAYS_IN = { desktop: 'Claude desktopu', cli: 'terminálu', sdk: 'aplikaci, která ji vedla' };

function seconds(ms) {
  if (ms < 59_950) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** `claude-fable-5-1` → „Fable 5.1“, `claude-sonnet-4-5-20250929` → „Sonnet 4.5“, `opus` → „Opus“. */
export function formatModel(id) {
  const raw = String(id ?? '');
  const long = /\[1m\]$/i.test(raw) ? ' 1M' : '';
  const parts = raw.replace(/\[1m\]$/i, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-').filter(Boolean);
  const words = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && /^\d+(\.\d+)*$/.test(words.at(-1) ?? '')) words[words.length - 1] += `.${p}`;
    else words.push(/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1));
  }
  return words.join(' ') + long || raw;
}

/** „výchozí (fable)“ – what '' (Claude Code's own setting) means. */
const byDefault = (value) => `výchozí${value ? ` (${value})` : ''}`;

/** Label of a model or effort value: the main process's one, else made up. */
function optionLabel(list, value, fallback, format = (v) => v) {
  const label = list?.find((o) => o.value === value)?.label;
  return label || (value ? format(value) : byDefault(fallback));
}

/** Options of a select: the ones from the main process ('' = Claude Code's default) plus an unknown current value. */
function choices(list, value, prefix, fallback, format) {
  const all = list.some((o) => o.value === '') ? list : [{ value: '', label: '' }, ...list];
  const known = all.some((o) => o.value === value);
  return [
    ...all.map((o) => html`<option value=${o.value}>${prefix}: ${optionLabel(all, o.value, fallback, format)}</option>`),
    known ? null : html`<option value=${value}>${prefix}: ${format ? format(value) : value}</option>`,
  ];
}

/** Model and effort selects (the composer, the new-task dialog). `onChange` gets { model } or { effort }. */
export function OptionSelects({ model, effort, onChange, disabled }) {
  const o = chat.options;
  if (!o) return null;
  const m = model ?? '';
  const e = effort ?? '';
  return html`<span class="opts">
    <select class="model" value=${m} disabled=${disabled} title="Model – změna platí od další odpovědi"
      onChange=${(ev) => onChange({ model: ev.currentTarget.value })}>${choices(o.models ?? [], m, 'Model', o.defaults?.model, formatModel)}</select>
    <select class="effort" value=${e} disabled=${disabled} title="Effort – jak moc se Claude snaží (víc = pomalejší a dražší)"
      onChange=${(ev) => onChange({ effort: ev.currentTarget.value })}>${choices(o.efforts ?? [], e, 'Effort', o.defaults?.effort)}</select>
  </span>`;
}

/** Model and effort the conversation runs with: what you picked for it, else the defaults. */
function picked(s) {
  const p = s.managed === false ? chat.picked.get(s.id) : null;
  return { model: p?.model ?? s.model ?? '', effort: p?.effort ?? s.effort ?? '' };
}

function Badges({ s }) {
  const o = chat.options;
  const { model, effort } = picked(s);
  const modelText = s.liveModel ? formatModel(s.liveModel) : optionLabel(o?.models, model, o?.defaults?.model, formatModel);
  const effortText = optionLabel(o?.efforts, effort, o?.defaults?.effort);
  const source = s.managed === false ? SOURCES[s.source] ?? SOURCES.other : null;
  return html`<span class="badges">
    ${source ? html`<span class="badge src" title=${`Konverzace z ${STAYS_IN[s.source] ?? 'jiné aplikace'} – odpověď vytvoří kopii v kanceláři`}>${source[0]} ${source[1]}</span>` : null}
    <span class="badge" title=${s.liveModel ? `Model: ${s.liveModel}` : 'Model'}>${modelText}</span>
    <span class="badge" title="Effort">⚡ ${effortText}</span>
  </span>`;
}

function Markdown({ text, live }) {
  const htmlText = useMemo(() => markdown(text), [text]);
  return html`<div class=${`md${live ? ' live' : ''}`} dangerouslySetInnerHTML=${{ __html: htmlText }} />`;
}

/** Your message; hover: rewind to before it, or fork the conversation after its reply. */
function User({ item, id, index, busy }) {
  const wait = busy ? 'Počkej, až Claude dokončí práci' : null;
  return html`<div class="msg user">
    <div class="who">
      <span>Ty</span>
      ${item.images ? html`<span class="tag" title="Přiložené obrázky">🖼 ${item.images}</span>` : null}
      <span class="acts">
        <button disabled=${busy} title=${wait ?? 'Vrátit konverzaci před tuhle zprávu – text se vloží do pole pro novou zprávu'}
          onClick=${() => openModal('rewind', { id, index, text: item.text })}>↶ Vrátit sem</button>
        <button disabled=${busy} title=${wait ?? 'Kopie konverzace až po odpověď na tuhle zprávu – originál zůstane'}
          onClick=${() => forkChat(id, index + 1)}>⑂ Větvit odsud</button>
      </span>
    </div>
    <div class="body">${item.text}${item.truncated ? html`<span class="trunc"> (zkráceno)</span>` : null}</div>
  </div>`;
}

function Thinking({ item }) {
  const [open, setOpen] = useState(false);
  return html`<div class=${`thinking${open ? ' open' : ''}`}>
    <div class="head" onClick=${() => setOpen(!open)}>
      <span class="arr">${open ? '▾' : '▸'}</span> 💭 ${item.done ? 'Přemýšlel…' : html`Přemýšlí<span class="dots" />`}
    </div>
    ${open ? html`<div class="text">${item.text}</div>` : null}
  </div>`;
}

function Tool({ item }) {
  const [open, setOpen] = useState(false);
  const more = item.input != null || item.output != null;
  const label = item.label === item.name || item.name.startsWith('mcp__') ? '' : item.label; // an MCP tool's label is its name again
  return [
    html`<div class=${`tool ${item.status}${more ? ' more' : ''}`} title=${label ? `${item.name} ${label}` : item.name} onClick=${more ? () => setOpen(!open) : null}>
      <span class="arr">${more ? (open ? '▾' : '▸') : ''}</span>
      <span class="ico">${toolIcon(item.name)}</span><span class="name">${toolName(item.name)}</span>
      <span class="label">${label}</span><span class="st">${STATUS[item.status] ?? ''}</span>
    </div>`,
    open ? html`<div class="tool-detail">
      ${item.input != null ? html`<pre class="in">${item.input}</pre>` : null}
      ${item.output != null ? html`<pre class=${`out${item.status === 'err' ? ' err' : ''}`}>${item.output}</pre>` : null}
    </div>` : null,
  ];
}

function Item({ item, prev, id, index, busy }) {
  switch (item?.kind) {
    case 'user':
      return html`<${User} item=${item} id=${id} index=${index} busy=${busy} />`;
    case 'text':
      return html`<div class="msg claude"><${Markdown} text=${item.text} live=${!item.done} /></div>`;
    case 'thinking':
      return html`<${Thinking} item=${item} />`;
    case 'tool':
      return html`<${Tool} item=${item} />`;
    case 'notice':
      return html`<div class=${`notice ${item.tone}`}>${item.text}</div>`;
    case 'done': {
      // an API error ends the turn with the text of the notice right above it – once is enough
      const repeated = item.error && prev?.kind === 'notice' && prev.tone === 'error' && String(prev.text).startsWith(item.error);
      const parts = [item.error ? `✕ ${repeated ? 'chyba' : item.error}` : '✓ hotovo'];
      if (item.ms != null) parts.push(seconds(item.ms));
      return html`<div class=${`turn-end${item.error ? ' error' : ''}`}>${parts.join(' · ')}</div>`;
    }
    default:
      return null;
  }
}

function lastDone(items) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.kind === 'done') return items[i];
  return null;
}

function statusLine(s, w, items) {
  if (s.busy) return `⚙ ${s.activity || 'pracuje…'}`;
  if (w?.waiting) return '🙋 čeká na tvoje povolení';
  if (s.managed === false) return `naposledy ${ago(s.lastActive)}${s.turns ? ` · ${s.turns}× odpověď` : ''}`;
  const failed = lastDone(items)?.error;
  if (failed) return `✕ ${failed}`;
  if (!s.running) return s.summary ? `💤 ${s.summary}` : '💤 doma – napiš a vrátí se do kanceláře';
  return s.summary ? `✓ ${s.summary}` : '✓ čeká na tebe';
}

function Composer({ s }) {
  const id = s.id;
  const foreign = s.managed === false;
  const [text, setText] = useState(() => chat.drafts.get(id) ?? '');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const edit = (value) => {
    setText(value);
    setDraft(id, value);
  };
  const send = async () => {
    const t = text;
    if (!t.trim() || sending) return;
    edit('');
    setSending(true);
    const ok = await sendMessage(id, t);
    setSending(false);
    if (!ok && !chat.drafts.get(id)) edit(t); // give the text back
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const { model, effort } = picked(s);
  const placeholder = foreign ? 'Napiš zprávu… (Enter odešle a vytvoří kopii v kanceláři)'
    : s.busy ? 'Další zpráva – přijde na řadu, až Claude dokončí tuhle' : 'Napiš zprávu… (Enter odešle, Shift+Enter nový řádek)';
  return html`<div class="composer">
    ${foreign ? html`<div class="hint">Odpověď vytvoří kopii konverzace v kanceláři – původní zůstane v ${STAYS_IN[s.source] ?? 'původní aplikaci'}.</div>` : null}
    <textarea ref=${ref} rows="1" value=${text} onInput=${(e) => edit(e.currentTarget.value)} onKeyDown=${onKey} placeholder=${placeholder} />
    <div class="actions">
      <${OptionSelects} model=${model} effort=${effort} onChange=${(change) => setChatOptions(id, change)} />
      <span class="grow" />
      ${s.busy ? html`<button class="stop" onClick=${() => window.office.chat.stop(id)} title="Přerušit práci">■ Zastavit</button>` : null}
      <button class="primary" disabled=${!text.trim() || sending} onClick=${send}>${sending && foreign ? 'Kopíruji…' : 'Odeslat'}</button>
    </div>
  </div>`;
}

export function Panel() {
  const id = state.chatOpen;
  const s = id ? chat.sessions.get(id) : null;
  const items = (id && chat.items.get(id)) || [];
  const w = id ? workers.get(id) : null;
  const [renaming, setRenaming] = useState(false);
  const list = useRef(null);
  const pinned = useRef(true); // follow the conversation unless you scrolled up to read
  const onScroll = () => {
    const el = list.current;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useLayoutEffect(() => {
    pinned.current = true;
    setRenaming(false);
  }, [id]);
  useLayoutEffect(() => {
    if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  });
  if (!s) return null;

  const foreign = s.managed === false;
  const who = w?.displayName ?? w?.name;
  // the running employee (and whom they cover for), else the conversation's owner
  const head = who ?? s.owner?.name;
  const cover = w?.coverFor;
  const onClick = (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    window.office.openExternal(a.href);
  };
  let ordinal = -1; // your messages are counted for rewind and fork
  return html`<div class="panel">
    <header>
      <button class="back" onClick=${closeChat} title="Zpět na seznam konverzací (Esc)">‹</button>
      <div class="title">
        <div class="name">${head ? html`<b>${head}</b> · ` : ''}${cover ? html`<span title=${`Vlastník konverzace: ${cover.name} – právě pracuje na jiné konverzaci`}>zastupuje ${cover.whom ?? cover.name}</span> · ` : ''}${s.project}</div>
        ${renaming
          ? html`<${TitleEdit} value=${s.title} onSave=${(t) => { setRenaming(false); if (t !== s.title) renameChat(id, t); }} onCancel=${() => setRenaming(false)} />`
          : html`<div class="task editable" title=${`${s.title || 'Bez názvu'}\n${s.cwd}\nKlik = přejmenovat`} onClick=${() => setRenaming(true)}>${s.title || 'Bez názvu'}</div>`}
        <div class="status-row">
          <div class=${`status${s.busy ? ' busy' : ''}`}>${statusLine(s, w, items)}</div>
          <${Badges} s=${s} />
        </div>
      </div>
      <div class="buttons">
        ${s.running && !s.busy && !foreign ? html`<button onClick=${() => window.office.chat.dismiss(id)} title="Ukončit session – konverzaci můžeš kdykoli dál psát">🏠 Domů</button>` : null}
        <button class="close" onClick=${hidePanel} title="Schovat panel">✕</button>
      </div>
    </header>
    <div class="items" ref=${list} onScroll=${onScroll} onClick=${onClick}>
      ${items.length
        ? items.map((item, i) => {
          if (item?.kind === 'user') ordinal += 1;
          return html`<${Item} key=${`${id}:${i}`} item=${item} prev=${items[i - 1]} id=${id} index=${item?.kind === 'user' ? ordinal : null} busy=${s.busy} />`;
        })
        : html`<div class="empty">Konverzace je zatím prázdná.</div>`}
      ${s.busy ? html`<div class="working">${who ?? 'Claude'} pracuje<span class="dots" /></div>` : null}
    </div>
    ${chat.error ? html`<div class="notice error panel-error"><span>${chat.error}</span><button class="close" onClick=${clearError} title="Zavřít">✕</button></div>` : null}
    <${Composer} key=${id} s=${s} />
  </div>`;
}
