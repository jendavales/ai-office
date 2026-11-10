/** Dialogs of the conversation UI: a new task (⌘N) and the conversation switcher (⌘K). */
import { html, useEffect, useRef, useState } from './lib.js';
import { chat, closeModal, openChat } from './store.js';

const LAST_PROJECT = 'ai-office:last-project';

function remembered() {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

function remember(dir) {
  try {
    localStorage.setItem(LAST_PROJECT, dir);
  } catch { /* storage unavailable */ }
}

const ago = (ts) => {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'teď';
  if (min < 60) return `před ${min} min`;
  if (min < 24 * 60) return `před ${Math.round(min / 60)} h`;
  return `před ${Math.round(min / 1440)} d`;
};

function Modal({ title, children, wide }) {
  return html`<div class="backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeModal(); }}>
    <div class=${`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="head"><h2>${title}</h2><button class="close" onClick=${closeModal} title="Zavřít (Esc)">✕</button></div>
      ${children}
    </div>
  </div>`;
}

function NewTask() {
  const [projects, setProjects] = useState(null);
  const [cwd, setCwd] = useState(remembered() ?? '');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    window.office.chat.projects().then((list) => {
      setProjects(list);
      setCwd((dir) => (list.some((p) => p.path === dir) ? dir : list[0]?.path ?? dir));
    });
    ref.current?.focus();
  }, []);

  const pick = async () => {
    const dir = await window.office.chat.pickFolder();
    if (!dir) return;
    setProjects((list) => (list?.some((p) => p.path === dir) ? list : [{ path: dir, label: dir.split('/').pop() }, ...(list ?? [])]));
    setCwd(dir);
    ref.current?.focus();
  };
  const submit = async () => {
    if (!cwd || !prompt.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const id = await window.office.chat.create({ cwd, prompt });
      remember(cwd);
      await openChat(id);
    } catch (err) {
      setError(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
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
      <select value=${cwd} onChange=${(e) => setCwd(e.currentTarget.value)}>
        ${!projects?.length && !cwd ? html`<option value="">Vyber složku…</option>` : null}
        ${(projects ?? []).map((p) => html`<option value=${p.path}>${label(p)}</option>`)}
        ${cwd && projects && !projects.some((p) => p.path === cwd) ? html`<option value=${cwd}>${cwd}</option>` : null}
      </select>
      <button onClick=${pick}>Jiná složka…</button>
    </div>
    <label>Co má udělat</label>
    <textarea ref=${ref} rows="5" value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)} onKeyDown=${onKey}
      placeholder="Popiš úkol… (Enter zadá, Shift+Enter nový řádek)" />
    ${error ? html`<div class="error">${error}</div>` : null}
    <div class="foot">
      <span class="hint">Úkol převezme volný člen týmu projektu.</span>
      <button class="primary" disabled=${!cwd || !prompt.trim() || sending} onClick=${submit}>${sending ? 'Zadávám…' : 'Zadat úkol'}</button>
    </div>
  </${Modal}>`;
}

const statusIcon = (s) => (s.busy ? '⚙' : s.running ? '●' : '○');

function Switcher() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const needle = q.trim().toLowerCase();
  const list = [...chat.sessions.values()]
    .filter((s) => !needle || `${s.project} ${s.title} ${s.cwd}`.toLowerCase().includes(needle))
    .sort((a, b) => b.lastActive - a.lastActive);
  // grouped by project, the project with the most recent conversation first
  const groups = new Map();
  for (const s of list) groups.set(s.project, [...(groups.get(s.project) ?? []), s]);
  const rows = [...groups.values()].flat();
  useEffect(() => { setSel(0); }, [q]);
  const go = (s) => s && openChat(s.id);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, rows.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); go(rows[sel]); }
  };
  let lastProject = null;
  return html`<${Modal} title="Konverzace" wide>
    <input ref=${ref} value=${q} onInput=${(e) => setQ(e.currentTarget.value)} onKeyDown=${onKey} placeholder="Hledat podle projektu nebo úkolu…" />
    <div class="list">
      ${rows.length ? rows.map((s, i) => {
        const head = s.project !== lastProject ? html`<div class="group">${s.project}</div>` : null;
        lastProject = s.project;
        return html`${head}<div class=${`entry${i === sel ? ' sel' : ''}`} onMouseEnter=${() => setSel(i)} onClick=${() => go(s)}>
          <span class=${`st${s.busy ? ' busy' : ''}`}>${statusIcon(s)}</span>
          <span class="t">${s.title || 'Nový úkol'}</span>
          <span class="when">${ago(s.lastActive)}</span>
        </div>`;
      }) : html`<div class="empty">${q ? 'Nic nenalezeno.' : 'Zatím žádné konverzace. Zadej první úkol přes ⌘N.'}</div>`}
    </div>
    <div class="foot"><span class="hint">↑↓ vybrat · Enter otevřít · ⌘N nový úkol</span></div>
  </${Modal}>`;
}

export function Dialogs() {
  if (chat.modal === 'new') return html`<${NewTask} />`;
  if (chat.modal === 'switch') return html`<${Switcher} />`;
  return null;
}
