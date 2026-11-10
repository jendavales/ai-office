/** The director's panel next to the office: Todoist tasks by deadline, a new task, the token settings. */
import { html, useEffect, useRef, useState } from '../chat/lib.js';
import { FILTERS, bucketOf, dayKey, emptyText, fmtDue, groupTasks, summarize } from './model.js';
import { hasMacros, parseQuickAdd } from './quickadd.js';
import {
  addTodo, closeTodos, doneTodo, forgetToken, refreshTodos, saveToken, setFilter, setTodoDue, showSettings, todo,
} from './store.js';

const PRIORITY = { 4: ['p1', '#e43b44'], 3: ['p2', '#ef7d57'], 2: ['p3', '#41a6f6'] };
const PRIORITIES = [[1, 'bez priority'], [4, '⚑ p1'], [3, '⚑ p2'], [2, '⚑ p3']];

/** The quick-add shortcuts, as a tooltip of the new-task field. */
const QUICK_ADD_HELP = `Zkratky v textu jako v Todoistu:
  !!1 … !!4 nebo p1 … p4 – priorita (1 = nejvyšší)
  #projekt – projekt (na diakritice a velikosti písmen nezáleží, i víc slov, stačí jednoznačný začátek; neznámý zůstane v textu)
  @štítek – štítek (i víc)
  dnes · zítra · pozítří · (v) pátek · příští úterý · příští týden · za 3 dny · za měsíc · 12. 11. (2027) · 2026-12-24 – termín, i anglicky (opakovaný ne)
  14:00 nebo v 14:00 – čas (bez data na den z pole termín, jinak dnes)
  // popis – všechno za // je popis úkolu`;

const openLink = (url) => window.office.openExternal(url);

const ago = (ts) => {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'právě teď';
  return min < 60 ? `před ${min} min` : `před ${Math.round(min / 60)} h`;
};

function Settings() {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const s = todo.status;
  const submit = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    const ok = await saveToken(token);
    setSaving(false);
    if (ok) setToken('');
  };
  const error = todo.error ?? (s?.configured ? null : s?.error);
  return html`<div class="todo-setup">
    <h3>Napojení na Todoist</h3>
    <p>Ředitel hlídá úkoly z tvého Todoistu. Potřebuje k tomu osobní API token: v Todoistu otevři <b>Nastavení → Integrace → Vývojář</b> a token zkopíruj sem.</p>
    <p><a href=${s?.tokenPage ?? '#'} onClick=${(e) => { e.preventDefault(); if (s?.tokenPage) openLink(s.tokenPage); }}>Otevřít nastavení Todoistu ↗</a></p>
    <label>API token</label>
    <input ref=${ref} type="password" value=${token} autocomplete="off" placeholder="0123456789abcdef…"
      onInput=${(e) => setToken(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') submit(); }} />
    ${error ? html`<div class="error">${error}</div>` : null}
    <div class="actions">
      ${s?.configured ? html`<button onClick=${() => showSettings(false)}>Zpět</button>
        <button class="danger" onClick=${forgetToken}>Zapomenout token</button>` : null}
      <button class="primary" disabled=${!token.trim() || saving} onClick=${submit}>${saving ? 'Ověřuji…' : 'Uložit a načíst'}</button>
    </div>
    <p class="hint">${s?.encrypted ? 'Token se ukládá zašifrovaný klíčenkou macOS' : 'Token se ukládá'} do složky aplikace a posílá se jen na api.todoist.com.</p>
  </div>`;
}

function Filters() {
  const f = todo.filter;
  const until = f && typeof f === 'object' ? f.until : '';
  return html`<div class="todo-filters">
    ${FILTERS.map(([key, label]) => html`<button class=${f === key ? 'active' : ''} onClick=${() => setFilter(key)}>${label}</button>`)}
    <label class="until" title="Úkoly s termínem do zvoleného dne">do
      <input type="date" value=${until} onChange=${(e) => setFilter(e.currentTarget.value ? { until: e.currentTarget.value } : 'today')} />
    </label>
  </div>`;
}

/** Date picker that opens as soon as it appears (changing a deadline). */
function DateInput({ value, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    try { ref.current?.showPicker?.(); } catch { /* needs a user gesture in some states – the field still works */ }
  }, []);
  return html`<input ref=${ref} type="date" value=${value ?? ''} onChange=${(e) => onChange(e.currentTarget.value || null)} />`;
}

function Task({ task, today, editing, setEditing }) {
  const busy = todo.busy.has(task.id);
  const bucket = bucketOf(task, today);
  const prio = PRIORITY[task.priority];
  const change = (due) => {
    setEditing(null);
    if (due !== task.due) setTodoDue(task.id, due);
  };
  return html`<div class=${`todo-task ${bucket}${busy ? ' busy' : ''}`}>
    <button class="check" title="Hotovo" disabled=${busy} onClick=${() => doneTodo(task.id)}>${busy ? '…' : ''}</button>
    <div class="body">
      <div class="content" title=${task.description || 'Otevřít v Todoistu'} onClick=${() => openLink(task.url)}>${task.content}</div>
      <div class="meta">
        ${prio ? html`<span class="prio" style=${{ color: prio[1] }}>⚑ ${prio[0]}</span>` : null}
        ${task.project ? html`<span class="project">${task.project}</span>` : null}
        ${editing === task.id
          ? html`<span class="due-edit">
              <${DateInput} value=${task.due} onChange=${change} />
              ${task.due ? html`<button onClick=${() => change(null)}>bez termínu</button>` : null}
              <button onClick=${() => setEditing(null)}>zrušit</button>
            </span>`
          : html`<button class=${`due ${bucket}`} title="Změnit termín" onClick=${() => setEditing(task.id)}>
              📅 ${fmtDue(task.due, today)}${task.time ? ` ${task.time}` : ''}${task.recurring ? ' ↻' : ''}
            </button>`}
        ${task.deadline ? html`<span class="deadline" title="Deadline v Todoistu">⏰ do ${fmtDue(task.deadline, today)}</span>` : null}
      </div>
    </div>
  </div>`;
}

/** What the shortcuts in the text resolved to – shown under the field while typing. */
function Preview({ parsed, due, today }) {
  const prio = parsed.priority ? PRIORITY[parsed.priority] : null;
  return html`<div class="preview">
    ${parsed.content ? html`<span class="what">${parsed.content}</span>` : html`<span class="what missing">chybí text úkolu</span>`}
    ${prio ? html`<span class="chip" style=${{ color: prio[1] }}>⚑ ${prio[0]}</span>` : parsed.priority ? html`<span class="chip">bez priority</span>` : null}
    ${parsed.project ? html`<span class="chip">${parsed.project}</span>` : null}
    ${parsed.unknownProject ? html`<span class="chip warn" title="Takový projekt v Todoistu není – zůstane v textu úkolu">${parsed.unknownProject} ?</span>` : null}
    ${parsed.due || parsed.time ? html`<span class="chip">📅 ${fmtDue(due, today)}${parsed.time ? ` ${parsed.time}` : ''}</span>` : null}
    ${parsed.labels.map((l) => html`<span class="chip" key=${l}>@${l}</span>`)}
    ${parsed.description ? html`<span class="chip" title=${parsed.description}>📝 popis</span>` : null}
  </div>`;
}

function Composer({ today }) {
  const f = todo.filter;
  // a new task lands in the list you are looking at: today's filters prefill today, the date filter its day
  const defaultDue = f && typeof f === 'object' ? f.until : f === 'today' || f === 'week' ? today : '';
  const [text, setText] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [project, setProject] = useState('');
  const [priority, setPriority] = useState(1);
  const [sending, setSending] = useState(false);
  const ref = useRef(null);
  useEffect(() => { setDue(defaultDue); }, [defaultDue]);
  // shortcuts typed into the text (!!1, #projekt, zítra…) win over the fields below, which then show their value
  const parsed = parseQuickAdd(text, { projects: todo.projects, today });
  const task = {
    content: parsed.content,
    // a time alone takes its day from the field below, or today (like Todoist)
    due: parsed.due ?? (due || (parsed.time ? today : null)),
    time: parsed.time,
    projectId: parsed.projectId ?? (project || null),
    priority: parsed.priority ?? priority,
    labels: parsed.labels,
    description: parsed.description,
  };
  const inbox = todo.projects.find((p) => p.inbox)?.id;
  const submit = async () => {
    if (!task.content || sending) return;
    setSending(true);
    const ok = await addTodo(task);
    setSending(false);
    if (ok) setText('');
    ref.current?.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const fromText = (on) => (on ? 'from-text' : '');
  return html`<div class="composer todo-add">
    <input ref=${ref} class="text" value=${text} placeholder="Nový úkol… (Enter přidá; !!1 priorita, #projekt, @štítek, zítra 14:00)" title=${QUICK_ADD_HELP}
      onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onKey} />
    ${hasMacros(parsed) ? html`<${Preview} parsed=${parsed} due=${task.due} today=${today} />` : null}
    <div class="actions">
      <label class=${fromText(parsed.due)} title=${parsed.due ? `Termín z textu: ${[parsed.dueText, parsed.time].filter(Boolean).join(' ')}` : 'Termín'}>termín
        <input type="date" value=${task.due ?? ''} disabled=${Boolean(parsed.due)} onChange=${(e) => setDue(e.currentTarget.value)} />
      </label>
      <select class=${fromText(parsed.projectId)} value=${task.projectId && task.projectId !== inbox ? task.projectId : ''} disabled=${Boolean(parsed.projectId)}
        onChange=${(e) => setProject(e.currentTarget.value)} title=${parsed.project ? 'Projekt z textu (#…)' : 'Projekt (nebo #projekt v textu)'}>
        ${todo.projects.length ? todo.projects.map((p) => html`<option value=${p.inbox ? '' : p.id}>${p.name}</option>`) : html`<option value="">Inbox</option>`}
      </select>
      <select class=${`prio ${fromText(parsed.priority)}`} value=${task.priority} disabled=${Boolean(parsed.priority)}
        onChange=${(e) => setPriority(Number(e.currentTarget.value))} title=${parsed.priority ? 'Priorita z textu (!!1…)' : 'Priorita (nebo !!1 … !!4 v textu)'}>
        ${PRIORITIES.map(([v, label]) => html`<option value=${v}>${label}</option>`)}
      </select>
      <button class="primary" disabled=${!task.content || sending} onClick=${submit}>${sending ? 'Přidávám…' : 'Přidat'}</button>
    </div>
  </div>`;
}

export function TodoPanel() {
  const today = dayKey();
  const [editing, setEditing] = useState(null);
  const s = todo.status;
  const sum = summarize(todo.tasks, today);
  const setup = !s || !s.configured || todo.settings;
  const groups = groupTasks(todo.tasks, todo.filter, today);
  const status = !s ? 'načítám…'
    : !s.configured ? 'Todoist není napojený'
      : s.error ? `⚠️ ${s.error}`
        : s.syncedAt ? `✓ Todoist · aktualizováno ${ago(s.syncedAt)}` : 'načítám úkoly…';
  return html`<div class="panel todo">
    <header>
      <div class="title">
        <div class="name"><b>Ředitel</b> · to jsi ty</div>
        <div class="task">${s?.configured ? `📋 ${sum.today} na dnes · ${sum.overdue} po termínu · ${sum.total} celkem` : '📋 Úkoly z Todoistu'}</div>
        <div class=${`status${s?.error ? ' error' : ''}`}>${status}</div>
      </div>
      <div class="buttons">
        ${s?.configured ? html`<button onClick=${() => refreshTodos(true)} disabled=${todo.loading} title="Načíst znovu">↻</button>
          <button onClick=${() => showSettings(!todo.settings)} title="Nastavení Todoistu">⚙</button>` : null}
        <button class="close" onClick=${closeTodos} title="Zavřít (Esc)">✕</button>
      </div>
    </header>
    ${setup ? html`<div class="items"><${Settings} /></div>` : html`
      <${Filters} />
      <div class="items">
        ${todo.error ? html`<div class="notice error">${todo.error}</div>` : null}
        ${groups.length
          ? groups.map((g) => html`<div class="todo-group" key=${g.bucket}>${g.label} <span class="n">${g.tasks.length}</span></div>
              ${g.tasks.map((t) => html`<${Task} key=${t.id} task=${t} today=${today} editing=${editing} setEditing=${setEditing} />`)}`)
          : html`<div class="empty">${todo.loading || !s.syncedAt ? 'Načítám…' : emptyText(todo.filter)}</div>`}
      </div>
      <${Composer} today=${today} />`}
  </div>`;
}
