// WorkForge side panel: choose an employee, choose where they work (an open tab
// or one of their systems in a new tab), start working. Runs the same core
// runtime as the web app; browser tools act in the task's working tab inside the
// user's own signed-in browser. The only network call is to the AI engine.
import { DB } from './core/db.js';
import { Runtime, TERMINAL } from './core/runtime.js';
import { createToolExecutor } from './core/tools.js';
import { PROVIDERS, isConfigured } from './core/ai.js';
import { SYSTEMS, SCOPE_LABELS, SYSTEM_SCOPES, allSystems, systemUrl, systemOrigins, systemForUrl, hostOf } from './core/catalog.js';
import { uid, now } from './core/util.js';
import { runBrowserAction, openWorkingTab } from './browser-tools.js';

const db = new DB('workforge-ext');
const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const statusClass = { completed: 'ok', running: 'run', queued: 'run', waiting_approval: 'warn', failed: 'err', needs_attention: 'err', cancelled: '', paused: 'warn' };
const LEVEL_TEXT = { allow: 'allowed', approval: 'needs approval', deny: 'blocked' };

async function getAI() { return (await chrome.storage.session.get('ai')).ai || {}; }
const getConnections = () => db.all('connections');

const executor = createToolExecutor({
  db,
  getConnections,
  browser: {
    open: (url) => openWorkingTab(url),
    exec: (action, args, { task }) => runBrowserAction(task.browser.tabId, action, args),
  },
  hooks: {
    async notify({ employee, task, title, message }) {
      await db.put('activity', { id: uid('act'), ts: now(), employeeId: employee.id, taskId: task?.id || null, origin: 'extension', type: 'notification', status: 'info', message: `${title}: ${message}`, output: message });
    },
  },
});

const runtime = new Runtime({
  db,
  executor,
  origin: 'extension',
  getAI,
  getConnections,
  getSettings: async () => (await chrome.storage.local.get('settings')).settings || {},
  getBusiness: async () => (await chrome.storage.local.get('business')).business || null,
});

// target: { kind: 'tab', id: tabId } | { kind: 'system', id: systemId } | null
const state = { screen: 'home', employeeId: null, target: null, taskId: null, instruction: '' };

// ------------------------------------------------------------ helpers
function sysLogo(id, systems, size = 16) {
  const name = systems[id]?.name || id.replace(/^custom_/, '');
  if (SYSTEMS[id]) return `<span class="sys-logo sm" title="${esc(name)}"><img src="icons/systems/${esc(id)}.svg" alt="${esc(name)}" width="${size}" height="${size}"></span>`;
  return `<span class="sys-logo sm neutral mono" title="${esc(name)}" style="display:inline-grid;place-items:center;width:${size}px;height:${size}px;border-radius:4px;background:#e2e8f0;color:#334155;font-size:${Math.round(size * 0.62)}px;font-weight:700">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

// Systems an employee works in (derived from permissions when `systems` is missing).
function employeeSystems(emp, systems) {
  const ids = Array.isArray(emp.systems) && emp.systems.length ? emp.systems : Object.keys(emp.permissions || {});
  return ids.filter((id) => systems[id]);
}

function originPattern(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : ''; } catch { return ''; }
}

// ------------------------------------------------------------ status bar
async function renderStatus() {
  const ai = await getAI();
  const { lastSyncAt, appOrigin, appUrl } = await chrome.storage.local.get(['lastSyncAt', 'appOrigin', 'appUrl']);
  const ready = isConfigured(ai);
  statusEl.innerHTML = `<span><span class="dot" style="background:${ready ? 'var(--ok)' : 'var(--warn)'}"></span>${ready ? `AI engine · ${esc(ai.model)}` : 'AI engine not set up'}</span>
    <span>${lastSyncAt ? `Synced ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not synced'}${appOrigin ? ` · <a href="#" id="open-app">open app</a>` : ''}</span>`;
  statusEl.querySelector('#open-app')?.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `${appUrl || `${appOrigin}/`}#/dashboard` }); });
}

// ------------------------------------------------------------ home
async function renderHome() {
  const employees = (await db.all('employees')).sort((a, b) => a.name.localeCompare(b.name));
  const ai = await getAI();
  if (!employees.length) {
    view.innerHTML = `<div class="card empty"><h2>No employees yet</h2><p class="small">Open your WorkForge app → <strong>Browser Extension</strong> → <strong>Connect extension</strong>. Your employees sync here automatically.</p></div>`;
    return;
  }
  const connections = await getConnections();
  const systems = allSystems(connections);
  const emp = employees.find((e) => e.id === state.employeeId);
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => /^https?:/.test(t.url || ''));
  const { appOrigin } = await chrome.storage.local.get('appOrigin');
  const workTabs = tabs.filter((t) => !appOrigin || !t.url.startsWith(appOrigin));
  const empSystems = emp ? employeeSystems(emp, systems) : [];
  const domains = emp?.browser?.domains || [];

  // Drop a selection that no longer exists; default to the current tab.
  if (state.target?.kind === 'tab' && !workTabs.some((t) => t.id === state.target.id)) state.target = null;
  if (state.target?.kind === 'system' && !empSystems.includes(state.target.id)) state.target = null;
  if (!state.target && emp) { const act = workTabs.find((t) => t.active); if (act) state.target = { kind: 'tab', id: act.id }; }

  const tasks = (await db.all('tasks')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
  const isSel = (kind, id) => state.target?.kind === kind && state.target.id === id;

  const tabNote = (t) => {
    const sys = systemForUrl(t.url, connections);
    if (sys && empSystems.includes(sys)) return `${esc(systems[sys].name)}`;
    const host = hostOf(t.url);
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return 'other website · read & navigate only';
    return `not one of ${esc(emp.name)}'s systems · can only open them from here`;
  };

  const systemOptions = empSystems.map((id) => {
    const url = systemUrl(id, connections);
    const connected = connections.some((c) => c.id === id);
    const hint = url ? `${esc(hostOf(url))}${connected ? '' : ' · not connected in the app'}` : 'Enter your address on the app’s Systems page and sync';
    return `<button class="option ${isSel('system', id) ? 'selected' : ''}" data-sys="${esc(id)}" ${url ? '' : 'disabled'}>
      ${sysLogo(id, systems, 18)}<span class="grow"><div class="ellipsis">Open ${esc(systems[id].name)} in a new tab</div><div class="tiny muted ellipsis">${hint}</div></span></button>`;
  }).join('');

  const permRows = empSystems.map((id) => {
    const p = emp.permissions?.[id] || {};
    return `<div class="row tiny" style="gap:6px;align-items:center;margin-top:4px">${sysLogo(id, systems, 14)}<span><strong>${esc(systems[id].name)}</strong> — ${SYSTEM_SCOPES.map((s) => `${esc(SCOPE_LABELS[s])}: ${esc(LEVEL_TEXT[p[s]] || 'blocked')}`).join(' · ')}</span></div>`;
  }).join('');

  const canStart = !!state.target && isConfigured(ai) && emp?.status !== 'paused';

  view.innerHTML = `
    ${isConfigured(ai) ? '' : `<div class="callout warn">The AI engine isn't set up in the extension. In the app, turn on sharing the AI key with the extension (Settings) and it syncs here — or enter it in ⚙ Settings.</div>`}
    <div class="card"><div class="step-label">Step 1</div><h2>Which employee should work?</h2>
      ${employees.map((e) => {
        const ids = employeeSystems(e, systems);
        return `<button class="option ${e.id === state.employeeId ? 'selected' : ''}" data-emp="${esc(e.id)}">
        <span class="avatar" style="background:${esc(e.avatar?.color || '#6366f1')}">${esc(e.avatar?.initials || '?')}</span>
        <span class="grow"><div><strong>${esc(e.name)}</strong> — ${esc(e.role)}</div>
          <div class="row" style="gap:4px;margin-top:3px;flex-wrap:wrap;align-items:center">${ids.length ? ids.map((id) => sysLogo(id, systems, 16)).join('') : '<span class="tiny muted">No systems yet</span>'}</div></span>
        ${e.status === 'paused' ? '<span class="badge warn">paused</span>' : ''}</button>`;
      }).join('')}
    </div>
    ${emp ? `<div class="card"><div class="step-label">Step 2</div><h2>Where should ${esc(emp.name)} work?</h2>
      ${systemOptions}
      ${workTabs.length ? `<div class="tiny muted" style="margin:8px 0 4px">Or an open tab</div>${workTabs.map((t) => `<button class="option ${isSel('tab', t.id) ? 'selected' : ''}" data-tab="${t.id}">${t.favIconUrl && /^https:/.test(t.favIconUrl) ? `<img class="fav" src="${esc(t.favIconUrl)}" alt="">` : '<span class="fav" style="background:#e2e8f0"></span>'}<span class="grow"><div class="ellipsis">${esc(t.title || t.url)}</div><div class="tiny muted ellipsis">${esc(new URL(t.url).host)}${t.active ? ' · current tab' : ''} · ${tabNote(t)}</div></span></button>`).join('')}` : (empSystems.length ? '' : '<p class="small muted">Open the website you want the employee to work on in this window.</p>')}
      ${domains.length ? `<p class="tiny muted">${esc(emp.name)} may also read other websites: ${domains.map(esc).join(', ')}</p>` : ''}
    </div>
    <div class="card"><div class="step-label">Step 3</div><h2>What should ${esc(emp.name)} do?</h2>
      <textarea id="instruction" placeholder="e.g. Go through the unread emails, answer the routine ones and flag anything urgent.">${esc(state.instruction || '')}</textarea>
      <label class="field">Start at<select id="entry">${(emp.scripts || []).map((s) => `<option value="${esc(s.id)}" ${s.id === emp.entryScript ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      ${permRows ? `<div style="margin-top:8px"><div class="tiny muted">What ${esc(emp.name)} may do</div>${permRows}</div>` : ''}
      <button class="btn primary block" id="start" style="margin-top:10px" ${canStart ? '' : 'disabled'}>▶ Start Working</button>
      <p class="tiny muted" id="start-msg" style="margin-top:6px"></p>
    </div>` : ''}
    ${tasks.length ? `<div class="card"><h3 style="margin-bottom:6px">Recent tasks</h3>${tasks.map((t) => `<button class="option" data-task="${esc(t.id)}"><span class="grow"><div class="ellipsis">${esc(t.title)}</div><div class="tiny muted">${esc(empById[t.employeeId]?.name || '')} · ${new Date(t.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></span><span class="badge ${statusClass[t.status] || ''}">${esc(t.status.replace('_', ' '))}</span></button>`).join('')}</div>` : ''}`;

  view.querySelectorAll('[data-emp]').forEach((b) => b.onclick = () => { if (state.employeeId !== b.dataset.emp) state.target = null; state.employeeId = b.dataset.emp; renderHome(); });
  view.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { state.target = { kind: 'tab', id: Number(b.dataset.tab) }; renderHome(); });
  view.querySelectorAll('[data-sys]').forEach((b) => b.onclick = () => { state.target = { kind: 'system', id: b.dataset.sys }; renderHome(); });
  view.querySelectorAll('[data-task]').forEach((b) => b.onclick = () => { state.taskId = b.dataset.task; state.screen = 'task'; render(); });
  view.querySelector('#instruction')?.addEventListener('input', (e) => { state.instruction = e.target.value; });
  view.querySelector('#start')?.addEventListener('click', (e) => start(e.currentTarget, emp, { workTabs, connections, systems, empSystems }));
}

// Everything the permission request needs is computed from data loaded at render
// time, so chrome.permissions.request is the first async call inside the click
// (Chrome only shows the prompt during a user gesture).
function start(button, emp, { workTabs, connections, systems, empSystems }) {
  const msg = view.querySelector('#start-msg');
  const target = state.target;
  if (!emp || !target) return;
  let site; // { url, title, tabId? }
  if (target.kind === 'tab') {
    const tab = workTabs.find((t) => t.id === target.id);
    if (!tab) return;
    site = { url: tab.url, title: tab.title, tabId: tab.id };
  } else {
    const url = systemUrl(target.id, connections);
    if (!url) { msg.textContent = `Enter your ${systems[target.id]?.name || target.id} address on the app's Systems page and sync.`; return; }
    site = { url, title: systems[target.id]?.name || hostOf(url) };
  }
  const siteOrigin = originPattern(site.url);
  if (!siteOrigin) { msg.textContent = 'Employees can only work on http(s) pages.'; return; }
  const origins = [...new Set([
    siteOrigin,
    ...empSystems.flatMap((id) => systemOrigins(id, connections)),
    ...(emp.browser?.domains || []).flatMap((d) => [`https://${d}/*`, `https://*.${d}/*`]),
  ])];
  const instruction = view.querySelector('#instruction').value.trim();
  const entryScript = view.querySelector('#entry').value;
  button.disabled = true;
  msg.textContent = '';
  state.starting = true; // pause live re-renders while the tab opens
  chrome.permissions.request({ origins }).then(async (granted) => {
    if (!granted) {
      state.starting = false;
      msg.textContent = `${emp.name} can't work without access to ${hostOf(site.url)}. Click Start Working again and choose Allow.`;
      button.disabled = false;
      return;
    }
    if (!site.tabId) {
      msg.textContent = `Opening ${site.title}…`;
      const opened = await openWorkingTab(site.url, { active: true });
      site = { url: opened.url, title: opened.title, tabId: opened.tabId };
    }
    state.starting = false;
    await launch(emp, site, { instruction, entryScript });
  }).catch((e) => { state.starting = false; msg.textContent = e.message; button.disabled = false; });
}

async function launch(emp, site, { instruction, entryScript }) {
  const host = hostOf(site.url);
  const task = await runtime.createTask(emp, {
    input: instruction || `Work on the page “${site.title}” (${site.url}) according to your responsibilities.`,
    title: instruction ? undefined : `${emp.name} in ${host}`,
    trigger: 'browser extension',
    entryScript,
    browser: { tabId: site.tabId, url: site.url, title: site.title, origin: new URL(site.url).origin },
  });
  state.instruction = '';
  state.taskId = task.id;
  state.screen = 'task';
  render();
}

// ------------------------------------------------------------ task view
async function renderTask() {
  const task = await db.get('tasks', state.taskId);
  if (!task) { state.screen = 'home'; return render(); }
  const emp = await db.get('employees', task.employeeId);
  const connections = await getConnections();
  const systems = allSystems(connections);
  const log = (await db.byIndex('activity', 'taskId', task.id)).sort((a, b) => a.ts - b.ts);
  const approvals = (await db.byIndex('approvals', 'status', 'pending')).filter((a) => a.taskId === task.id);
  const colors = { success: 'var(--ok)', error: 'var(--err)', blocked: 'var(--err)', rejected: 'var(--err)', waiting: 'var(--warn)', running: 'var(--primary)', approved: 'var(--ok)' };
  const live = !TERMINAL.has(task.status);
  const curSys = task.browser?.url ? systemForUrl(task.browser.url, connections) : null;
  const where = task.browser?.url ? `${curSys ? `${sysLogo(curSys, systems, 14)} ${esc(systems[curSys].name)} · ` : ''}${esc(hostOf(task.browser.url))}` : 'No working tab yet';
  view.innerHTML = `<div class="card">
      <div class="between"><div class="row"><span class="avatar" style="background:${esc(emp?.avatar?.color || '#6366f1')}">${esc(emp?.avatar?.initials || '?')}</span><div><strong>${esc(emp?.name || '')}</strong><div class="tiny muted row" style="gap:4px;align-items:center">${where}</div></div></div>
      <span class="badge ${statusClass[task.status] || ''}">${live && task.status === 'running' ? '<span class="spinner"></span>' : ''} ${esc(task.status.replace('_', ' '))}</span></div>
      <p class="small" style="margin-top:8px">${esc(task.title)}</p>
      ${task.error ? `<div class="callout err" style="margin-top:8px">${esc(task.error)}</div>` : ''}
      ${task.result && !live ? `<div class="callout" style="margin-top:8px">${esc(task.result)}</div>` : ''}
      <div class="row" style="margin-top:10px">${live ? '<button class="btn danger sm" id="stop">■ Stop</button>' : '<button class="btn sm" id="again">↻ Run again</button>'}${task.browser?.tabId ? '<button class="btn sm" id="show-tab">Show tab</button>' : ''}<button class="btn sm" id="back">← Back</button></div>
    </div>
    ${approvals.map((a) => `<div class="approval" data-ap="${esc(a.id)}"><strong>${esc(a.summary)}</strong>
      ${a.kind === 'escalation' ? `<textarea data-response placeholder="Your answer…"></textarea>` : `<pre data-args>${esc(JSON.stringify(a.args, null, 2))}</pre><textarea data-edit hidden>${esc(JSON.stringify(a.args, null, 2))}</textarea>`}
      <div class="row">${a.kind === 'escalation' ? '<button class="btn ok sm" data-do="respond">Send</button><button class="btn danger sm" data-do="reject">Decline</button>' : '<button class="btn ok sm" data-do="approve">Approve</button><button class="btn sm" data-do="edit">Edit</button><button class="btn danger sm" data-do="reject">Reject</button>'}</div></div>`).join('')}
    <div class="card"><h3 style="margin-bottom:4px">Activity</h3><div class="log" id="log">${log.map((l) => `<div class="log-item"><span class="ldot" style="background:${colors[l.status] || '#cbd5e1'}"></span><div style="flex:1;min-width:0"><div>${esc(l.message)}</div>${l.tool ? `<div class="tiny muted">${esc(l.tool)}${l.scriptName ? ` · ${esc(l.scriptName)}` : ''}</div>` : ''}</div><span class="t">${time(l.ts)}</span></div>`).join('') || '<p class="small muted">Starting…</p>'}</div></div>`;
  const lg = view.querySelector('#log');
  lg.scrollTop = lg.scrollHeight;
  view.querySelector('#stop')?.addEventListener('click', () => runtime.cancelTask(task.id));
  view.querySelector('#back').onclick = () => { state.screen = 'home'; render(); };
  view.querySelector('#show-tab')?.addEventListener('click', async () => {
    try { const tab = await chrome.tabs.update(task.browser.tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch { alert('The working tab was closed.'); }
  });
  view.querySelector('#again')?.addEventListener('click', async () => {
    // Reuse the working tab if it is still open; otherwise the employee opens its system again (browser_open).
    let browser = null;
    if (task.browser?.tabId) {
      try { const tab = await chrome.tabs.get(task.browser.tabId); browser = { ...task.browser, url: tab.url, title: tab.title, origin: new URL(tab.url).origin }; } catch { browser = null; }
    }
    const t = await runtime.createTask(emp, { input: task.input, title: task.title, trigger: 'browser extension', entryScript: task.entryScript, browser });
    state.taskId = t.id;
    render();
  });
  view.querySelectorAll('[data-ap]').forEach((node) => {
    const id = node.dataset.ap;
    node.querySelectorAll('[data-do]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        if (b.dataset.do === 'approve') await runtime.resolveApproval(id, 'approve');
        if (b.dataset.do === 'reject') await runtime.resolveApproval(id, 'reject');
        if (b.dataset.do === 'respond') await runtime.resolveApproval(id, 'approve', { response: node.querySelector('[data-response]').value });
        if (b.dataset.do === 'edit') {
          const ta = node.querySelector('[data-edit]');
          if (ta.hidden) { ta.hidden = false; node.querySelector('[data-args]').hidden = true; b.textContent = 'Approve edited'; b.disabled = false; return; }
          await runtime.resolveApproval(id, 'edit', { args: JSON.parse(ta.value) });
        }
      } catch (e) { alert(e.message); b.disabled = false; }
    });
  });
}

// ------------------------------------------------------------ settings
async function renderSettings() {
  const { pairedOrigins = [], customOrigins = [] } = await chrome.storage.local.get(['pairedOrigins', 'customOrigins']);
  const ai = await getAI();
  const perms = await chrome.permissions.getAll();
  const required = new Set(chrome.runtime.getManifest().host_permissions);
  const optional = (perms.origins || []).filter((o) => !required.has(o));
  const webAll = optional.includes('https://*/*');
  const provider = PROVIDERS[ai?.provider] ? ai.provider : 'anthropic';
  view.innerHTML = `<div class="card"><h2>Connected WorkForge apps</h2>
      ${pairedOrigins.length ? pairedOrigins.map((o) => `<div class="between small" style="padding:4px 0"><span class="ellipsis">${esc(o)}</span><button class="btn sm danger" data-unpair="${esc(o)}">Remove</button></div>`).join('') : '<p class="small muted">None. Open your WorkForge app → Browser Extension → Connect extension.</p>'}
      <label class="field">Add WorkForge app address (custom domain)<input id="custom" placeholder="https://workforge.example.com"></label>
      <button class="btn sm" id="add-custom" style="margin-top:6px">Add address</button>
      ${customOrigins.length ? `<p class="tiny muted" style="margin-top:6px">Custom: ${customOrigins.map(esc).join(', ')}</p>` : ''}
    </div>
    <div class="card"><h2>Site access</h2>
      <p class="small muted">Sites employees may work on, in your own signed-in browser. Start Working asks for the sites it needs.</p>
      ${optional.filter((o) => o !== 'https://*/*' && o !== 'http://*/*').map((o) => `<div class="between small" style="padding:4px 0"><span class="ellipsis">${esc(o)}</span><button class="btn sm" data-revoke="${esc(o)}">Revoke</button></div>`).join('') || '<p class="small muted">No sites allowed yet.</p>'}
      <div class="between" style="margin-top:8px"><span class="small">Allow any https site</span><button class="btn sm" id="web-all">${webAll ? 'Disable' : 'Allow'}</button></div>
    </div>
    <div class="card"><h2>AI engine</h2>
      <p class="small muted">${isConfigured(ai) ? `Using ${esc(PROVIDERS[ai.provider]?.label || ai.provider)} · ${esc(ai.model)} (synced from the app or entered here). Kept in session storage — cleared when the browser closes.` : 'Not set up. Turn on sharing the AI key with the extension in the app’s Settings and it syncs here, or enter it below.'}</p>
      <label class="field">Provider<select id="ai-provider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <label class="field">Model<input id="ai-model" value="${esc(ai?.model || PROVIDERS[provider].defaultModel)}"></label>
      <label class="field">Base URL (OpenAI-compatible only)<input id="ai-base" value="${esc(ai?.baseUrl || '')}"></label>
      <label class="field">Provider key<input id="ai-key" type="password" placeholder="${ai?.apiKey ? '•••• saved' : ''}"></label>
      <button class="btn sm primary" id="ai-save" style="margin-top:8px">Save for this session</button>
    </div>`;
  view.querySelectorAll('[data-unpair]').forEach((b) => b.onclick = async () => {
    await chrome.storage.local.set({ pairedOrigins: pairedOrigins.filter((o) => o !== b.dataset.unpair) });
    renderSettings();
  });
  view.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { await chrome.permissions.remove({ origins: [b.dataset.revoke] }); renderSettings(); });
  view.querySelector('#web-all').onclick = async () => {
    if (webAll) await chrome.permissions.remove({ origins: ['https://*/*'] });
    else await chrome.permissions.request({ origins: ['https://*/*'] });
    renderSettings();
  };
  view.querySelector('#add-custom').onclick = async () => {
    let origin;
    try { const u = new URL(view.querySelector('#custom').value.trim()); if (!/^https?:$/.test(u.protocol)) throw new Error(); origin = u.origin; } catch { return alert('Enter a valid https:// address'); }
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return;
    const r = await chrome.runtime.sendMessage({ channel: 'wf-internal', type: 'registerOrigin', origin });
    alert(r?.ok ? `Added. Reload ${origin} and click “Connect extension”.` : `Failed: ${r?.error}`);
    renderSettings();
  };
  view.querySelector('#ai-save').onclick = async () => {
    const cur = await getAI();
    const p = view.querySelector('#ai-provider').value;
    const next = { provider: p, model: view.querySelector('#ai-model').value.trim(), baseUrl: p === 'anthropic' ? '' : view.querySelector('#ai-base').value.trim(), effort: cur.effort || '', apiKey: view.querySelector('#ai-key').value.trim() || cur.apiKey || '' };
    await chrome.storage.session.set({ ai: next });
    renderStatus();
    renderSettings();
  };
}

// ------------------------------------------------------------ router
async function render() {
  await renderStatus();
  if (state.screen === 'settings') return renderSettings();
  if (state.screen === 'task') return renderTask();
  return renderHome();
}

document.getElementById('nav-home').onclick = () => { state.screen = 'home'; render(); };
document.getElementById('nav-settings').onclick = () => { state.screen = 'settings'; render(); };

let t;
const homeBusy = () => state.screen === 'home' && (state.starting || document.activeElement?.id === 'instruction');
db.on((e) => {
  if (state.screen === 'settings' || homeBusy()) return;
  if (['tasks', 'activity', 'approvals', 'employees', 'connections'].includes(e.store)) { clearTimeout(t); t = setTimeout(render, 250); }
});
chrome.tabs.onActivated.addListener(() => { if (state.screen === 'home' && !homeBusy()) render(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (state.screen === 'home' && info.status === 'complete' && !homeBusy()) render(); });
chrome.storage.onChanged.addListener(() => renderStatus());

render();
runtime.recover();
