// WorkForce SPA bootstrap: hash router and application shell.
import { app, db, events, startBackground } from './state.js';
import { vault } from './vault.js';
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

const NAV = [
  ['dashboard', 'layout-dashboard', 'Overview'],
  ['employees', 'users', 'Employees'],
  ['create', 'plus', 'Create Employee'],
  ['activity', 'activity', 'Activity'],
  ['tasks', 'list-checks', 'Tasks'],
  ['approvals', 'shield-check', 'Approvals'],
  ['files', 'folder', 'Files'],
  ['systems', 'server', 'Systems'],
  ['integrations', 'blocks', 'Integrations'],
  ['extension', 'puzzle', 'Browser Extension'],
  ['reports', 'bar-chart-3', 'Reports'],
  ['settings', 'settings', 'Settings'],
];

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
    container.innerHTML = '<div class="page"><div class="spinner"></div></div>';
    updateNav(path);
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

function shellHtml() {
  return `<div class="shell">
    <aside class="sidebar">
      <a class="logo" href="#/">${'<img src="assets/img/logo.svg" alt="">'}WorkForce</a>
      <button class="workspace" data-nav="/settings/business">
        <div class="ws-logo" id="ws-logo">W</div>
        <div class="grow"><div class="strong small ellipsis" id="ws-name">Your business</div><div class="tiny muted">Workspace</div></div>
        ${icon('chevrons-up-down')}
      </button>
      <nav class="nav">
        <div class="nav-label">Workspace</div>
        ${NAV.map(([p, ic, label]) => `<a href="#/${p}" data-path="/${p}">${icon(ic)}<span>${label}</span>${p === 'approvals' ? '<span class="count warn" id="nav-approvals" hidden></span>' : ''}${p === 'employees' ? '<span class="count" id="nav-employees" hidden></span>' : ''}</a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="engine-card" id="engine-card"></div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="Menu">${icon('menu')}</button>
        <div class="search input-icon" style="position:relative">${icon('search')}<input class="input" id="global-search" placeholder="Search employees, tasks, files…" autocomplete="off"><div id="search-pop" class="search-pop" hidden></div></div>
        <div class="grow"></div>
        <button class="icon-btn" id="vault-btn" title="Credential vault" hidden>${icon('lock')}</button>
        <a class="icon-btn" href="#/approvals" title="Approvals">${icon('bell')}<span class="pip" id="bell-pip" hidden></span></a>
        <a class="btn btn-primary btn-sm" href="#/create">${icon('sparkles')}Create Employee</a>
      </header>
      <div id="page"></div>
    </div>
  </div>`;
}

function updateNav(path) {
  document.querySelectorAll('.nav a').forEach((a) => {
    const p = a.dataset.path;
    a.classList.toggle('active', path === p || (p !== '/' && path.startsWith(`${p}/`)) || (p === '/create' && path.startsWith('/generate')));
  });
}

async function refreshChrome() {
  if (!document.querySelector('.shell')) return;
  const [approvals, employees] = await Promise.all([db.byIndex('approvals', 'status', 'pending'), db.all('employees')]);
  const n = approvals.length;
  const navA = document.getElementById('nav-approvals');
  const pip = document.getElementById('bell-pip');
  if (navA) { navA.hidden = !n; navA.textContent = n; }
  if (pip) { pip.hidden = !n; pip.textContent = n; }
  const navE = document.getElementById('nav-employees');
  if (navE) { navE.hidden = !employees.length; navE.textContent = employees.length; }
  const b = app.business;
  const wsName = document.getElementById('ws-name');
  if (wsName) wsName.textContent = b?.name || 'Your business';
  const wsLogo = document.getElementById('ws-logo');
  if (wsLogo) wsLogo.textContent = (b?.name || 'W').slice(0, 1).toUpperCase();
  const ai = await app.getAI();
  const ready = await app.aiReady();
  const card = document.getElementById('engine-card');
  if (card) {
    card.innerHTML = `<div class="between"><span class="strong">AI Engine</span><span class="badge ${ready ? 'badge-success' : vault.locked ? 'badge-warning' : 'badge-danger'}"><span class="dot"></span>${ready ? 'Ready' : vault.locked ? 'Locked' : 'Not set'}</span></div>
      <div class="muted tiny mt-4 ellipsis">${ready ? esc(ai.model) : vault.locked ? 'Unlock the vault to run employees' : 'Add your API key in Settings'}</div>
      <div class="between mt-8"><span class="tiny muted">Extension</span><span class="tiny ${bridge.paired ? '' : 'muted'}">${bridge.paired ? 'Connected' : bridge.available ? 'Not paired' : 'Not installed'}</span></div>`;
    card.onclick = () => navigate(ready ? '/extension' : '/settings/ai');
    card.style.cursor = 'pointer';
  }
  const vb = document.getElementById('vault-btn');
  if (vb) {
    vb.hidden = vault.mode !== 'encrypted';
    vb.innerHTML = icon(vault.locked ? 'lock' : 'unlock');
    vb.title = vault.locked ? 'Unlock credential vault' : 'Lock credential vault';
  }
  refreshIcons();
}

async function globalSearch(q) {
  const pop = document.getElementById('search-pop');
  if (!q.trim()) { pop.hidden = true; return; }
  const ql = q.toLowerCase();
  const [emps, tasks, files] = await Promise.all([db.all('employees'), db.all('tasks'), db.all('files')]);
  const hits = [
    ...emps.filter((e) => `${e.name} ${e.role} ${e.summary}`.toLowerCase().includes(ql)).slice(0, 5).map((e) => `<a href="#/employees/${e.id}">${avatar(e, 'avatar-sm')}<div><div class="strong small">${esc(e.name)}</div><div class="tiny muted">${esc(e.role)}</div></div></a>`),
    ...tasks.filter((t) => `${t.title} ${t.input}`.toLowerCase().includes(ql)).slice(0, 5).map((t) => `<a href="#/tasks/${t.id}">${icon('list-checks')}<div><div class="small">${esc(t.title)}</div><div class="tiny muted">${esc(t.status)}</div></div></a>`),
    ...files.filter((f) => f.name.toLowerCase().includes(ql)).slice(0, 5).map((f) => `<a href="#/files">${icon('file-text')}<div class="small">${esc(f.name)}</div></a>`),
  ];
  pop.innerHTML = hits.length ? hits.join('') : '<div class="small muted" style="padding:10px">No results</div>';
  pop.hidden = false;
  refreshIcons();
}

function bindShell() {
  const root = document.getElementById('root');
  on(root, 'click', '#menu-toggle', () => document.querySelector('.shell').classList.toggle('nav-open'));
  on(root, 'click', '[data-nav]', (e, el) => navigate(el.dataset.nav));
  on(root, 'input', '#global-search', debounce((e) => globalSearch(e.target.value), 150));
  on(root, 'click', '#search-pop a', () => { document.getElementById('search-pop').hidden = true; document.getElementById('global-search').value = ''; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) { const p = document.getElementById('search-pop'); if (p) p.hidden = true; } });
  on(root, 'click', '#vault-btn', async () => {
    if (vault.locked) {
      const { unlockDialog } = await import('./pages/settings.js');
      unlockDialog();
    } else { vault.lock(); toast('Vault locked'); }
  });
}

async function boot() {
  try {
    await app.load();
  } catch (e) {
    document.getElementById('root').innerHTML = `<div class="page"><div class="callout danger">${icon('alert-triangle')}<div>WorkForce could not open its local database (IndexedDB). Private browsing modes may block it.<div class="small mt-4">${esc(e.message)}</div></div></div></div>`;
    return;
  }
  bindShell();
  startBackground();
  window.addEventListener('hashchange', () => { route().then(refreshChrome); });
  db.on(debounce((e) => { if (['approvals', 'employees', 'settings'].includes(e.store)) refreshChrome(); }, 250));
  events.on(() => refreshChrome());
  vault.onChange(() => refreshChrome());
  await route();
  refreshChrome();
  if (vault.mode === 'encrypted' && vault.locked && location.hash.length > 2 && !location.hash.startsWith('#/onboarding')) {
    const { unlockDialog } = await import('./pages/settings.js');
    unlockDialog();
  }
}

boot();
