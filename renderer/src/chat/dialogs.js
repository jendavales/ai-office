/** Dialogs of the conversation UI: a new task (⌘N) and rewinding a conversation to before one of your messages. */
import { html, ipcError, useEffect, useRef, useState } from './lib.js';
import { OptionSelects } from './panel.js';
import { chat, closeModal, loadOptions, lockModal, openChat, refreshList, rewindChat, setDraft } from './store.js';

const LAST_PROJECT = 'ai-office:last-project';
const LAST_OPTIONS = 'ai-office:last-options';

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

function lastOptions() {
  try {
    const o = JSON.parse(remembered(LAST_OPTIONS) ?? '{}');
    return { model: typeof o.model === 'string' ? o.model : '', effort: typeof o.effort === 'string' ? o.effort : '' };
  } catch {
    return { model: '', effort: '' };
  }
}

function Modal({ title, children, wide }) {
  return html`<div class="backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeModal(); }}>
    <div class=${`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="head"><h2>${title}</h2><button class="close" onClick=${closeModal} disabled=${Boolean(chat.modal?.busy)} title="Zavřít (Esc)">✕</button></div>
      ${children}
    </div>
  </div>`;
}

function NewTask() {
  const [projects, setProjects] = useState(null);
  const [cwd, setCwd] = useState(remembered(LAST_PROJECT) ?? '');
  const [prompt, setPrompt] = useState(() => chat.drafts.get('new') ?? '');
  const [options, setOptions] = useState(lastOptions);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    window.office.chat.projects().then((list) => {
      setProjects(list);
      setCwd((dir) => (list.some((p) => p.path === dir) ? dir : list[0]?.path ?? dir));
    });
    loadOptions(); // the defaults may have changed in Claude Code's settings
    ref.current?.focus();
  }, []);

  const pick = async () => {
    const dir = await window.office.chat.pickFolder();
    if (!dir) return;
    setProjects((list) => (list?.some((p) => p.path === dir) ? list : [{ path: dir, label: dir.split('/').pop() }, ...(list ?? [])]));
    setCwd(dir);
    ref.current?.focus();
  };
  const choose = (change) => {
    const next = { ...options, ...change };
    setOptions(next);
    remember(LAST_OPTIONS, JSON.stringify(next));
  };
  const submit = async () => {
    if (!cwd || !prompt.trim() || sending) return;
    setSending(true);
    lockModal(true); // no closing until the task exists
    setError('');
    try {
      const id = await window.office.chat.create({ cwd, prompt, model: options.model || null, effort: options.effort || null });
      remember(LAST_PROJECT, cwd);
      setDraft('new', '');
      lockModal(false);
      refreshList();
      await openChat(id);
    } catch (err) {
      lockModal(false);
      setError(ipcError(err));
      setSending(false);
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const label = (p) => `${p.label}  —  ${p.path.replace(/^\/Users\/[^/]+/, '~')}`;
  return html`<${Modal} title="Nový úkol">
    <label>Projekt</label>
    <div class="row">
      <select value=${cwd} disabled=${sending} onChange=${(e) => setCwd(e.currentTarget.value)}>
        ${!projects?.length && !cwd ? html`<option value="">Vyber složku…</option>` : null}
        ${(projects ?? []).map((p) => html`<option value=${p.path}>${label(p)}</option>`)}
        ${cwd && projects && !projects.some((p) => p.path === cwd) ? html`<option value=${cwd}>${cwd}</option>` : null}
      </select>
      <button onClick=${pick} disabled=${sending}>Jiná složka…</button>
    </div>
    <label>Co má udělat</label>
    <textarea ref=${ref} rows="5" value=${prompt} disabled=${sending} onKeyDown=${onKey}
      onInput=${(e) => { setPrompt(e.currentTarget.value); setDraft('new', e.currentTarget.value); }}
      placeholder="Popiš úkol… (Enter zadá, Shift+Enter nový řádek)" />
    <div class="row opts-row"><${OptionSelects} model=${options.model} effort=${options.effort} disabled=${sending} onChange=${choose} /></div>
    ${error ? html`<div class="error">${error}</div>` : null}
    <div class="foot">
      <span class="hint">Úkol převezme volný člen týmu projektu.</span>
      <button class="primary" disabled=${!cwd || !prompt.trim() || sending} onClick=${submit}>${sending ? 'Zadávám…' : 'Zadat úkol'}</button>
    </div>
  </${Modal}>`;
}

function Rewind({ id, index, text }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    lockModal(true);
    const ok = await rewindChat(id, index, text);
    if (!ok) {
      lockModal(false);
      setBusy(false);
    }
  };
  return html`<${Modal} title="Vrátit konverzaci sem?">
    <p class="text">Konverzace se vrátí před tuto zprávu. Pozdější zprávy z kanceláře zmizí (přepis zůstane v ~/.claude), text zprávy se vloží do pole pro novou zprávu.</p>
    <blockquote class="quote">${text}</blockquote>
    ${chat.error ? html`<div class="error">${chat.error}</div>` : null}
    <div class="foot">
      <span class="hint">Originál zmizí ze seznamu, pokračuje se v kopii.</span>
      <span class="row">
        <button onClick=${closeModal} disabled=${busy}>Zrušit</button>
        <button ref=${ref} class="primary" onClick=${go} disabled=${busy}>${busy ? 'Vracím…' : 'Vrátit'}</button>
      </span>
    </div>
  </${Modal}>`;
}

export function Dialogs() {
  const m = chat.modal;
  if (m?.kind === 'new') return html`<${NewTask} />`;
  if (m?.kind === 'rewind') return html`<${Rewind} key=${`${m.id}:${m.index}`} id=${m.id} index=${m.index} text=${m.text} />`;
  return null;
}
