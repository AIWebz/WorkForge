// WorkForge SPA bootstrap: hash router, application shell and command palette.
import { app, db, events, startBackground } from './state.js';
import { bridge } from './bridge.js';
import { esc, icon, refreshIcons, on, debounce, avatar, toast } from './ui.js';

const ROUTES = [
  ['/', () => import('./pages/landing.js'), { bare: true }],
  ['/onboarding', () => import('./pages/onboarding.js'), { bare: true }],
  ['/dashboard', () => import('./pages/dashboard.js')],
  ['/employees', () => import('./pages/employees.js')],
  ['/employees/:id', () => import('./pages/profile.js')],
  ['/employees/:id/:tab', () => import('./pages/profile.js')],
  ['/create', () => import('./pages/create.js')],
  ['/generate/:job', () => import('./pages/create.js')],
  ['/activity', () => import('./pages/activity.js')],
  ['/tasks', () => import('./pages/tasks.js')],
  ['/tasks/:id', () => import('./pages/tasks.js')],
  ['/approvals', () => import('./pages/approvals.js')],
  ['/files', () => import('./pages/files.js')],
  ['/systems', () => import('./pages/systems.js')],
  ['/integrations', () => import('./pages/systems.js')],
  ['/extension', () => import('./pages/extension.js')],
  ['/reports', () => import('./pages/reports.js')],
  ['/settings', () => import('./pages/settings.js')],
  ['/settings/:section', () => import('./pages/settings.js')],
];

// Sidebar: grouped navigation. [path, lucide icon, label]
const NAV_GROUPS = [
  ['Operate', [
    ['dashboard', 'layout-dashboard', 'Overview'],
    ['employees', 'users', 'Employees'],
    ['tasks', 'list-checks', 'Tasks'],
    ['approvals', 'shield-check', 'Approvals'],
    ['activity', 'activity', 'Activity'],
  ]],
  ['Build', [
    ['create', 'plus', 'Create Employee'],
    ['files', 'folder', 'Files'],
    ['systems', 'app-window', 'Systems'],
  ]],
  ['Insights', [
    ['reports', 'bar-chart-3', 'Reports'],
  ]],
];
const NAV_BOTTOM = [
  ['extension', 'puzzle', 'Browser Extension'],
  ['settings', 'settings', 'Settings'],
];
const ALL_NAV = [...NAV_GROUPS.flatMap(([g, items]) => items.map((i) => [...i, g])), ...NAV_BOTTOM.map((i) => [...i, 'Workspace'])];
const NAV_INFO = Object.fromEntries(ALL_NAV.map(([p, ic, label, group]) => [p, { icon: ic, label, group }]));
NAV_INFO.integrations = NAV_INFO.systems;
NAV_INFO.generate = NAV_INFO.create;

const SETTINGS_LABELS = { ai: 'AI engine', business: 'Business', security: 'Security', data: 'Data', general: 'General', permissions: 'Permissions' };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD_KEY = IS_MAC ? '⌘K' : 'Ctrl K';

let cleanups = [];
let renderSeq = 0;

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

function match(path) {
  for (const [pattern, loader, opts = {}] of ROUTES) {
    const pp = pattern.split('/').filter(Boolean);
    const sp = path.split('/').filter(Boolean);
    if (pp.length !== sp.length) continue;
    const params = {};
    if (pp.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(sp[i])), true) : p === sp[i]))) return { loader, params, opts, pattern };
  }
  return null;
}

async function route() {
  const seq = ++renderSeq;
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
  closePalette();
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const m = match(path) || match('/dashboard');
  const root = document.getElementById('root');
  const mod = await m.loader();
  if (seq !== renderSeq) return;

  let container;
  if (m.opts.bare) {
    root.innerHTML = '<div id="bare"></div>';
    container = root.firstChild;
  } else {
    if (!document.querySelector('.shell')) root.innerHTML = shellHtml();
    container = document.getElementById('page');
    container.innerHTML = '<div class="page" aria-busy="true"><span class="skeleton skeleton-line" style="width:220px;height:22px"></span><span class="skeleton skeleton-line short"></span><span class="skeleton skeleton-block mt-24"></span></div>';
    updateNav(path);
    updateCrumbs(path, m.params);
    document.querySelector('.shell')?.classList.remove('nav-open');
  }
  const ctx = {
    app, db, params: m.params, el: container, navigate,
    query: Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')),
    cleanup: (fn) => cleanups.push(fn),
    watch(stores, fn, ms = 350) {
      const set = new Set(stores);
      const d = debounce(fn, ms);
      cleanups.push(db.on((e) => { if (set.has(e.store)) d(e); }));
    },
    isCurrent: () => seq === renderSeq,
  };
  try {
    await mod.default(ctx);
  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class="page"><div class="callout danger">${icon('alert-triangle')}<div><strong>Something went wrong.</strong><div class="small mt-4">${esc(e.message)}</div></div></div></div>`;
  }
  refreshIcons();
  window.scrollTo(0, 0);
}

const navLink = ([p, ic, label]) => `<a href="#/${p}" data-path="/${p}">${icon(ic)}<span>${label}</span>${p === 'approvals' ? '<span class="count warn" id="nav-approvals" hidden></span>' : ''}${p === 'employees' ? '<span class="count" id="nav-employees" hidden></span>' : ''}</a>`;

function shellHtml() {
  return `<div class="shell">
    <aside class="sidebar" aria-label="Main navigation">
      <a class="logo" href="#/"><img src="assets/img/logo.svg" alt="" width="22" height="22">WorkForge</a>
      <button class="workspace" data-nav="/settings/business" title="Edit business profile">
        <div class="ws-logo" id="ws-logo">${icon('briefcase')}</div>
        <div class="grow"><div class="tiny muted">Workspace</div><div class="ws-desc ellipsis" id="ws-name">Describe your business</div></div>
        ${icon('chevrons-up-down')}
      </button>
      <nav class="nav">
        ${NAV_GROUPS.map(([g, items]) => `<div class="nav-group"><div class="nav-label">${g}</div>${items.map(navLink).join('')}</div>`).join('')}
      </nav>
      <nav class="nav nav-bottom">${NAV_BOTTOM.map(navLink).join('')}</nav>
      <div class="sidebar-foot">
        <div class="engine-card" id="engine-card" role="button" tabindex="0"></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="Menu">${icon('menu')}</button>
        <div class="crumbs grow" id="crumbs"></div>
        <button class="cmdk-trigger" id="cmdk-open" aria-label="Search and commands" title="Search and commands (${MOD_KEY})">${icon('search')}<span>Search or jump to…</span><kbd class="kbd">${MOD_KEY}</kbd></button>
        <a class="icon-btn" href="#/approvals" title="Approvals">${icon('bell')}<span class="pip" id="bell-pip" hidden></span></a>
        <a class="btn btn-primary btn-sm btn-create" href="#/create">${icon('plus')}<span>Create employee</span></a>
      </header>
      <div id="page"></div>
    </div>
  </div>`;
}

function updateNav(path) {
  document.querySelectorAll('.nav a').forEach((a) => {
    const p = a.dataset.path;
    a.classList.toggle('active', path === p || (p !== '/' && path.startsWith(`${p}/`))
      || (p === '/create' && path.startsWith('/generate'))
      || (p === '/systems' && (path === '/integrations' || path.startsWith('/integrations/'))));
    if (a.classList.contains('active')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

async function updateCrumbs(path, params) {
  const el = document.getElementById('crumbs');
  if (!el) return;
  const seg = path.split('/').filter(Boolean);
  const info = NAV_INFO[seg[0]] || NAV_INFO.dashboard;
  const parts = [`<span class="crumb-root">${esc(info.group)}</span>`];
  const sep = '<span class="sep">/</span>';
  if (seg.length > 1) {
    parts.push(`<a href="#/${seg[0] === 'generate' ? 'create' : seg[0]}">${esc(info.label)}</a>`);
    let detail = '';
    try {
      if (seg[0] === 'employees' && params.id) detail = (await db.get('employees', params.id))?.name || 'Employee';
      else if (seg[0] === 'tasks' && params.id) detail = (await db.get('tasks', params.id))?.title || 'Task';
      else if (seg[0] === 'settings') detail = SETTINGS_LABELS[seg[1]] || seg[1].replace(/[-_]/g, ' ');
      else if (seg[0] === 'generate') detail = 'Generating';
    } catch { /* store may not exist */ }
    parts.push(`<span class="here ellipsis">${esc(detail || seg[1])}</span>`);
  } else {
    parts.push(`<span class="here">${esc(info.label)}</span>`);
  }
  if (path === (location.hash.replace(/^#/, '') || '/').split('?')[0]) el.innerHTML = parts.join(sep);
}

async function refreshChrome() {
  if (!document.querySelector('.shell')) return;
  const [approvals, employees] = await Promise.all([db.byIndex('approvals', 'status', 'pending'), db.all('employees')]);
  const n = approvals.length;
  const navA = document.getElementById('nav-approvals');
  const pip = document.getElementById('bell-pip');
  if (navA) { navA.hidden = !n; navA.textContent = n; }
  if (pip) { pip.hidden = !n; pip.textContent = n > 99 ? '99+' : n; }
  const navE = document.getElementById('nav-employees');
  if (navE) { navE.hidden = !employees.length; navE.textContent = employees.length; }
  // Workspace label: the business description only — WorkForge never asks for a company name.
  const desc = (app.business?.description || '').trim();
  const wsName = document.getElementById('ws-name');
  if (wsName) {
    wsName.textContent = desc || 'Describe your business';
    wsName.classList.toggle('placeholder', !desc);
    wsName.title = desc;
  }
  const ai = await app.getAI();
  const gpu = await app.engine.gpuInfo();
  const st = app.engine.status;
  const card = document.getElementById('engine-card');
  if (card) {
    const label = !gpu.supported ? 'No WebGPU' : st.state === 'ready' ? 'Running' : st.state === 'loading' ? `Loading ${Math.round((st.progress || 0) * 100)}%` : st.state === 'error' ? 'Error' : 'On device';
    const aiCls = !gpu.supported || st.state === 'error' ? 'err' : st.state === 'loading' ? 'warn' : 'ok';
    const extCls = bridge.paired ? 'ok' : bridge.available ? 'warn' : '';
    card.innerHTML = `<div class="eng-row"><span class="section-title">AI engine</span><span class="status-label ${aiCls}"><span class="dot"></span>${esc(label)}</span></div>
      <div class="eng-model ellipsis mt-4" title="${esc(ai.model)}">${gpu.supported ? esc(ai.model.replace(/-q4f(16|32)_1-MLC$/, '')) : 'Needs a WebGPU browser'}</div>
      <div class="eng-row mt-8"><span class="tiny muted">Extension</span><span class="status-label ${extCls}"><span class="dot"></span>${bridge.paired ? 'Connected' : bridge.available ? 'Not paired' : 'Not installed'}</span></div>`;
    card.onclick = () => navigate('/settings/ai');
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.onclick(); } };
    card.style.cursor = 'pointer';
  }
  refreshIcons();
}


// ---------------------------------------------------------- command palette
// Searches pages, employees, tasks and files, plus a few actions. Arrow keys
// move, Enter runs, Escape closes. Replaces the old topbar search popover.
let palette = null;

function closePalette() {
  if (!palette) return;
  palette.el.remove();
  document.removeEventListener('keydown', palette.onKey, true);
  const back = palette.returnFocus;
  palette = null;
  try { back?.focus?.(); } catch { /* ignore */ }
}

async function openPalette() {
  if (palette || !document.querySelector('.shell')) return;
  const el = document.createElement('div');
  el.className = 'cmdk-backdrop';
  el.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="cmdk-input">${icon('search')}<input id="cmdk-q" placeholder="Search pages, employees, tasks, files…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list"><kbd class="kbd">esc</kbd></div>
    <div class="cmdk-list" id="cmdk-list" role="listbox"><div class="cmdk-empty"><span class="spinner sm"></span></div></div>
    <div class="cmdk-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navigate</span><span><kbd class="kbd">↵</kbd> open</span><span><kbd class="kbd">esc</kbd> close</span></div>
  </div>`;
  document.body.appendChild(el);
  const state = { el, items: [], active: 0, data: null, returnFocus: document.activeElement };
  palette = state;
  const input = el.querySelector('#cmdk-q');
  const list = el.querySelector('#cmdk-list');
  input.focus();
  refreshIcons();

  const [emps, tasks, files] = await Promise.all([
    db.all('employees').catch(() => []), db.all('tasks').catch(() => []), db.all('files').catch(() => []),
  ]);
  if (palette !== state) return;
  state.data = { emps, tasks: tasks.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)), files };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const hit = (text) => terms.every((t) => text.toLowerCase().includes(t));
    const groups = [];
    const actions = [
      { icon: 'plus', label: 'Create employee', hint: 'action', run: () => navigate('/create'), text: 'create new employee generate hire' },
      { icon: 'app-window', label: 'Connect a system', hint: 'action', run: () => navigate('/systems'), text: 'connect add system web app integration' },
      { icon: 'puzzle', label: 'Set up the browser extension', hint: 'action', run: () => navigate('/extension'), text: 'install pair browser extension' },
      { icon: 'cpu', label: 'AI engine settings', hint: 'action', run: () => navigate('/settings/ai'), text: 'ai engine model gpu download settings' },
      { icon: 'briefcase', label: 'Edit business profile', hint: 'action', run: () => navigate('/settings/business'), text: 'business profile description workspace' },
    ];
    const pages = ALL_NAV.map(([p, ic, label, group]) => ({ icon: ic, label, hint: group.toLowerCase(), run: () => navigate(`/${p}`), text: `${label} ${p} ${group}` }));
    const empItems = state.data.emps.map((e) => ({ avatar: e, label: e.name, sub: e.role, hint: 'open employee', run: () => navigate(`/employees/${e.id}`), text: `${e.name} ${e.role || ''} ${e.summary || ''} open employee` }));
    const taskItems = state.data.tasks.map((t) => ({ icon: 'list-checks', label: t.title || 'Untitled task', hint: (t.status || '').replace(/_/g, ' '), run: () => navigate(`/tasks/${t.id}`), text: `${t.title || ''} ${t.input || ''} ${t.status || ''}` }));
    const fileItems = state.data.files.map((f) => ({ icon: 'file-text', label: f.name, hint: 'file', run: () => navigate('/files'), text: f.name || '' }));
    if (!terms.length) {
      groups.push(['Actions', actions.slice(0, 3)]);
      if (empItems.length) groups.push(['Employees', empItems.slice(0, 5)]);
      groups.push(['Go to', pages]);
      if (taskItems.length) groups.push(['Recent tasks', taskItems.slice(0, 4)]);
    } else {
      const f = (arr, n) => arr.filter((i) => hit(i.text)).slice(0, n);
      groups.push(['Actions', f(actions, 6)], ['Pages', f(pages, 8)], ['Employees', f(empItems, 6)], ['Tasks', f(taskItems, 6)], ['Files', f(fileItems, 5)]);
    }
    state.items = [];
    const html = groups.filter(([, items]) => items.length).map(([g, items]) => `<div class="cmdk-group" role="presentation">${g}</div>${items.map((it) => {
      const i = state.items.push(it) - 1;
      const lead = it.avatar ? avatar(it.avatar, 'avatar-sm') : icon(it.icon);
      return `<button type="button" class="cmdk-item" role="option" id="cmdk-${i}" data-i="${i}">${lead}<span class="cmdk-label">${esc(it.label)}${it.sub ? ` <span class="muted small">· ${esc(it.sub)}</span>` : ''}</span><span class="cmdk-hint">${esc(it.hint || '')}</span><span class="cmdk-enter">${icon('corner-down-left')}</span></button>`;
    }).join('')}`).join('');
    list.innerHTML = html || `<div class="cmdk-empty">No results for “${esc(input.value.trim())}”</div>`;
    state.active = 0;
    highlight();
    refreshIcons();
  };
  const highlight = () => {
    list.querySelectorAll('.cmdk-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === state.active));
    const cur = list.querySelector(`#cmdk-${state.active}`);
    if (cur) { cur.setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  };
  const run = (i) => {
    const it = state.items[i];
    if (!it) return;
    closePalette();
    it.run();
  };
  state.onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (!state.items.length) return;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); state.active = (state.active + 1) % state.items.length; highlight(); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); state.active = (state.active - 1 + state.items.length) % state.items.length; highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(state.active); }
  };
  document.addEventListener('keydown', state.onKey, true);
  input.addEventListener('input', render);
  list.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.cmdk-item');
    if (b && Number(b.dataset.i) !== state.active) { state.active = Number(b.dataset.i); highlight(); }
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('.cmdk-item'); if (b) run(Number(b.dataset.i)); });
  el.addEventListener('mousedown', (e) => { if (e.target === el) closePalette(); });
  render();
}

function bindShell() {
  const root = document.getElementById('root');
  on(root, 'click', '#menu-toggle', () => document.querySelector('.shell').classList.toggle('nav-open'));
  on(root, 'click', '[data-nav]', (e, el) => navigate(el.dataset.nav));
  on(root, 'click', '#cmdk-open', () => openPalette());
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      if (!document.querySelector('.shell')) return;
      e.preventDefault();
      if (palette) closePalette(); else openPalette();
    }
  });
  // Close the mobile drawer when tapping outside it.
  document.addEventListener('click', (e) => {
    const shell = document.querySelector('.shell.nav-open');
    if (shell && !e.target.closest('.sidebar') && !e.target.closest('#menu-toggle')) shell.classList.remove('nav-open');
  });
}

async function boot() {
  try {
    await app.load();
  } catch (e) {
    document.getElementById('root').innerHTML = `<div class="page"><div class="callout danger">${icon('alert-triangle')}<div>WorkForge could not open its local database (IndexedDB). Private browsing modes may block it.<div class="small mt-4">${esc(e.message)}</div></div></div></div>`;
    return;
  }
  bindShell();
  startBackground();
  window.addEventListener('hashchange', () => { route().then(refreshChrome); });
  db.on(debounce((e) => { if (['approvals', 'employees', 'settings'].includes(e.store)) refreshChrome(); }, 250));
  events.on(() => refreshChrome());
  app.engine.onStatus(debounce(() => refreshChrome(), 400));
  await route();
  refreshChrome();
}

boot();
