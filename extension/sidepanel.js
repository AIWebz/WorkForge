// WorkForge side panel: choose an employee, choose a tab, start working.
// Runs the same core runtime as the web app with the browser tool bound to the
// selected tab.
import { DB } from './core/db.js';
import { Runtime, TERMINAL } from './core/runtime.js';
import { createToolExecutor } from './core/tools.js';
import { PROVIDERS, isConfigured } from './core/ai.js';
import { uid, now } from './core/util.js';
import { runBrowserAction } from './browser-tools.js';

const db = new DB('workforge-ext');
const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const statusClass = { completed: 'ok', running: 'run', queued: 'run', waiting_approval: 'warn', failed: 'err', needs_attention: 'err', cancelled: '', paused: 'warn' };

async function session() { return chrome.storage.session.get(['ai', 'secrets']); }

const executor = createToolExecutor({
  db,
  async getConnection(id) {
    const rec = await db.get('connections', id);
    if (!rec) return null;
    const { secrets = {} } = await session();
    return { ...rec, secrets: secrets[id] || {} };
  },
  // Extension pages are not subject to CORS for hosts the extension may access.
  transport: {
    async fetch(url, init) {
      const u = new URL(url);
      if (!(await chrome.permissions.contains({ origins: [`${u.origin}/*`] }))) {
        throw new Error(`The extension has no access to ${u.host}. Allow it in Settings → Site access.`);
      }
      const res = await fetch(url, { ...init, credentials: 'omit' });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    },
  },
  browser: { exec: (action, args, { task }) => runBrowserAction(task.browser.tabId, action, args) },
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
  getAI: async () => (await session()).ai || {},
  getSettings: async () => (await chrome.storage.local.get('settings')).settings || {},
  getBusiness: async () => (await chrome.storage.local.get('business')).business || null,
});

const state = { screen: 'home', employeeId: null, tabId: null, taskId: null };

// ------------------------------------------------------------ status bar
async function renderStatus() {
  const { ai } = await session();
  const { lastSyncAt, appOrigin, appUrl } = await chrome.storage.local.get(['lastSyncAt', 'appOrigin', 'appUrl']);
  const ready = isConfigured(ai);
  statusEl.innerHTML = `<span><span class="dot" style="background:${ready ? 'var(--ok)' : 'var(--warn)'}"></span>${ready ? `AI engine · ${esc(ai.model)}` : 'AI engine not available'}</span>
    <span>${lastSyncAt ? `Synced ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not synced'}${appOrigin ? ` · <a href="#" id="open-app">open app</a>` : ''}</span>`;
  statusEl.querySelector('#open-app')?.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `${appUrl || `${appOrigin}/`}#/dashboard` }); });
}

// ------------------------------------------------------------ home
async function renderHome() {
  const employees = (await db.all('employees')).sort((a, b) => a.name.localeCompare(b.name));
  const { ai } = await session();
  if (!employees.length) {
    view.innerHTML = `<div class="card empty"><h2>No employees yet</h2><p class="small">Open your WorkForge app → <strong>Browser Extension</strong> → <strong>Connect extension</strong>. Your employees sync here automatically.</p></div>`;
    return;
  }
  const emp = employees.find((e) => e.id === state.employeeId);
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => /^https?:/.test(t.url || ''));
  const { appOrigin } = await chrome.storage.local.get('appOrigin');
  const workTabs = tabs.filter((t) => !appOrigin || !t.url.startsWith(appOrigin));
  if (!state.tabId) state.tabId = workTabs.find((t) => t.active)?.id || null;
  const tasks = (await db.all('tasks')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));

  view.innerHTML = `
    ${isConfigured(ai) ? '' : `<div class="callout warn">The AI engine isn't available in the extension. Enable “Share credentials with the browser extension” in the app (Settings → Security) and sync, or add a key in ⚙ Settings.</div>`}
    <div class="card"><div class="step-label">Step 1</div><h2>Which employee should work here?</h2>
      ${employees.map((e) => `<button class="option ${e.id === state.employeeId ? 'selected' : ''}" data-emp="${e.id}" ${e.browser?.enabled ? '' : 'disabled'}>
        <span class="avatar" style="background:${esc(e.avatar?.color || '#6366f1')}">${esc(e.avatar?.initials || '?')}</span>
        <span class="grow"><div><strong>${esc(e.name)}</strong> — ${esc(e.role)}</div><div class="tiny muted ellipsis">${e.browser?.enabled ? esc(e.summary) : 'Browser access disabled (enable in the app: Permissions → Browser)'}</div></span>
        ${e.status === 'paused' ? '<span class="badge warn">paused</span>' : ''}</button>`).join('')}
    </div>
    ${emp ? `<div class="card"><div class="step-label">Step 2</div><h2>Where should ${esc(emp.name)} work?</h2>
      ${workTabs.length ? workTabs.map((t) => `<button class="option ${t.id === state.tabId ? 'selected' : ''}" data-tab="${t.id}">${t.favIconUrl && /^https:/.test(t.favIconUrl) ? `<img class="fav" src="${esc(t.favIconUrl)}" alt="">` : '<span class="fav" style="background:#e2e8f0"></span>'}<span class="grow"><div class="ellipsis">${esc(t.title || t.url)}</div><div class="tiny muted ellipsis">${esc(new URL(t.url).host)}${t.active ? ' · current tab' : ''}</div></span></button>`).join('') : '<p class="small muted">Open the website you want the employee to work on in this window.</p>'}
      ${emp.browser.domains?.length ? `<p class="tiny muted">${esc(emp.name)} may also navigate to: ${emp.browser.domains.map(esc).join(', ')}</p>` : ''}
    </div>
    <div class="card"><div class="step-label">Step 3</div><h2>What should ${esc(emp.name)} do?</h2>
      <textarea id="instruction" placeholder="e.g. Go through the leads in this list, qualify each one and add notes to their record.">${esc(state.instruction || '')}</textarea>
      <label class="field">Start at<select id="entry">${emp.scripts.map((s) => `<option value="${esc(s.id)}" ${s.id === emp.entryScript ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <p class="tiny muted" style="margin-top:8px">Permissions — ${Object.entries(emp.permissions?.browser || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none'}</p>
      <button class="btn primary block" id="start" style="margin-top:10px" ${state.tabId && isConfigured(ai) && emp.status !== 'paused' ? '' : 'disabled'}>▶ Start Working</button>
    </div>` : ''}
    ${tasks.length ? `<div class="card"><h3 style="margin-bottom:6px">Recent browser tasks</h3>${tasks.map((t) => `<button class="option" data-task="${t.id}"><span class="grow"><div class="ellipsis">${esc(t.title)}</div><div class="tiny muted">${esc(empById[t.employeeId]?.name || '')} · ${new Date(t.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></span><span class="badge ${statusClass[t.status] || ''}">${esc(t.status.replace('_', ' '))}</span></button>`).join('')}</div>` : ''}`;

  view.querySelectorAll('[data-emp]').forEach((b) => b.onclick = () => { state.employeeId = b.dataset.emp; renderHome(); });
  view.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { state.tabId = Number(b.dataset.tab); renderHome(); });
  view.querySelectorAll('[data-task]').forEach((b) => b.onclick = () => { state.taskId = b.dataset.task; state.screen = 'task'; render(); });
  view.querySelector('#instruction')?.addEventListener('input', (e) => { state.instruction = e.target.value; });
  const tab = workTabs.find((x) => x.id === state.tabId);
  view.querySelector('#start')?.addEventListener('click', () => start(emp, tab));
}

function start(emp, tab) {
  if (!emp || !tab) return;
  const origin = new URL(tab.url).origin;
  const origins = [`${origin}/*`, ...(emp.browser.domains || []).flatMap((d) => [`https://${d}/*`, `https://*.${d}/*`])];
  // permissions.request must be the first async call inside the click so Chrome treats it as a user gesture.
  chrome.permissions.request({ origins }).then((granted) => {
    if (!granted) { alert(`WorkForge needs access to ${new URL(tab.url).host} for ${emp.name} to work there.`); return; }
    return launch(emp, tab, origin);
  }).catch((e) => alert(e.message));
}

async function launch(emp, tab, origin) {
  const instruction = view.querySelector('#instruction').value.trim();
  const task = await runtime.createTask(emp, {
    input: instruction || `Work on the page ${tab.title} (${tab.url}) according to your responsibilities.`,
    title: instruction ? undefined : `${emp.name} in ${new URL(tab.url).host}`,
    trigger: 'browser extension',
    entryScript: view.querySelector('#entry').value,
    browser: { tabId: tab.id, url: tab.url, title: tab.title, origin },
  });
  state.taskId = task.id;
  state.screen = 'task';
  render();
}

// ------------------------------------------------------------ task view
async function renderTask() {
  const task = await db.get('tasks', state.taskId);
  if (!task) { state.screen = 'home'; return render(); }
  const emp = await db.get('employees', task.employeeId);
  const log = (await db.byIndex('activity', 'taskId', task.id)).sort((a, b) => a.ts - b.ts);
  const approvals = (await db.byIndex('approvals', 'status', 'pending')).filter((a) => a.taskId === task.id);
  const colors = { success: 'var(--ok)', error: 'var(--err)', blocked: 'var(--err)', rejected: 'var(--err)', waiting: 'var(--warn)', running: 'var(--primary)', approved: 'var(--ok)' };
  const live = !TERMINAL.has(task.status);
  view.innerHTML = `<div class="card">
      <div class="between"><div class="row"><span class="avatar" style="background:${esc(emp?.avatar?.color || '#6366f1')}">${esc(emp?.avatar?.initials || '?')}</span><div><strong>${esc(emp?.name || '')}</strong><div class="tiny muted">${esc(task.browser?.origin ? new URL(task.browser.origin).host : '')}</div></div></div>
      <span class="badge ${statusClass[task.status] || ''}">${live && task.status === 'running' ? '<span class="spinner"></span>' : ''} ${esc(task.status.replace('_', ' '))}</span></div>
      <p class="small" style="margin-top:8px">${esc(task.title)}</p>
      ${task.error ? `<div class="callout err" style="margin-top:8px">${esc(task.error)}</div>` : ''}
      ${task.result && !live ? `<div class="callout" style="margin-top:8px">${esc(task.result)}</div>` : ''}
      <div class="row" style="margin-top:10px">${live ? '<button class="btn danger sm" id="stop">■ Stop</button>' : '<button class="btn sm" id="again">↻ Run again</button>'}<button class="btn sm" id="back">← Back</button></div>
    </div>
    ${approvals.map((a) => `<div class="approval" data-ap="${a.id}"><strong>${esc(a.summary)}</strong>
      ${a.kind === 'escalation' ? `<textarea data-response placeholder="Your answer…"></textarea>` : `<pre data-args>${esc(JSON.stringify(a.args, null, 2))}</pre><textarea data-edit hidden>${esc(JSON.stringify(a.args, null, 2))}</textarea>`}
      <div class="row">${a.kind === 'escalation' ? '<button class="btn ok sm" data-do="respond">Send</button><button class="btn danger sm" data-do="reject">Decline</button>' : '<button class="btn ok sm" data-do="approve">Approve</button><button class="btn sm" data-do="edit">Edit</button><button class="btn danger sm" data-do="reject">Reject</button>'}</div></div>`).join('')}
    <div class="card"><h3 style="margin-bottom:4px">Activity</h3><div class="log" id="log">${log.map((l) => `<div class="log-item"><span class="ldot" style="background:${colors[l.status] || '#cbd5e1'}"></span><div style="flex:1;min-width:0"><div>${esc(l.message)}</div>${l.tool ? `<div class="tiny muted">${esc(l.tool)}${l.scriptName ? ` · ${esc(l.scriptName)}` : ''}</div>` : ''}</div><span class="t">${time(l.ts)}</span></div>`).join('') || '<p class="small muted">Starting…</p>'}</div></div>`;
  const lg = view.querySelector('#log');
  lg.scrollTop = lg.scrollHeight;
  view.querySelector('#stop')?.addEventListener('click', () => runtime.cancelTask(task.id));
  view.querySelector('#back').onclick = () => { state.screen = 'home'; render(); };
  view.querySelector('#again')?.addEventListener('click', async () => {
    const t = await runtime.createTask(emp, { input: task.input, title: task.title, trigger: 'browser extension', entryScript: task.entryScript, browser: task.browser });
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
  const { ai } = await session();
  const perms = await chrome.permissions.getAll();
  const required = new Set(chrome.runtime.getManifest().host_permissions);
  const optional = (perms.origins || []).filter((o) => !required.has(o));
  const webAll = optional.includes('https://*/*');
  const provider = ai?.provider || 'anthropic';
  view.innerHTML = `<div class="card"><h2>Connected WorkForge apps</h2>
      ${pairedOrigins.length ? pairedOrigins.map((o) => `<div class="between small" style="padding:4px 0"><span class="ellipsis">${esc(o)}</span><button class="btn sm danger" data-unpair="${esc(o)}">Remove</button></div>`).join('') : '<p class="small muted">None. Open your WorkForge app → Browser Extension → Connect extension.</p>'}
      <label class="field">Add WorkForge app address (custom domain)<input id="custom" placeholder="https://workforce.example.com"></label>
      <button class="btn sm" id="add-custom" style="margin-top:6px">Add address</button>
      ${customOrigins.length ? `<p class="tiny muted" style="margin-top:6px">Custom: ${customOrigins.map(esc).join(', ')}</p>` : ''}
    </div>
    <div class="card"><h2>Site access</h2>
      <p class="small muted">Sites employees may work on. Granted when you click Start Working.</p>
      ${optional.filter((o) => o !== 'https://*/*' && o !== 'http://*/*').map((o) => `<div class="between small" style="padding:4px 0"><span class="ellipsis">${esc(o)}</span><button class="btn sm" data-revoke="${esc(o)}">Revoke</button></div>`).join('') || '<p class="small muted">No sites granted yet.</p>'}
      <div class="between" style="margin-top:8px"><span class="small">Allow web research on any https site</span><button class="btn sm" id="web-all">${webAll ? 'Disable' : 'Allow'}</button></div>
    </div>
    <div class="card"><h2>AI engine</h2>
      <p class="small muted">${isConfigured(ai) ? `Using ${esc(ai.provider)} · ${esc(ai.model)} (from sync or below). Stored in session storage — cleared when the browser closes.` : 'Not configured. Sync from the app with credential sharing on, or enter it here.'}</p>
      <label class="field">Provider<select id="ai-provider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <label class="field">Model<input id="ai-model" value="${esc(ai?.model || PROVIDERS[provider].defaultModel)}"></label>
      <label class="field">Base URL (OpenAI-compatible only)<input id="ai-base" value="${esc(ai?.baseUrl || '')}"></label>
      <label class="field">API key<input id="ai-key" type="password" placeholder="${ai?.apiKey ? '•••• saved' : ''}"></label>
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
    try { origin = new URL(view.querySelector('#custom').value.trim()).origin; } catch { return alert('Enter a valid https:// address'); }
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return;
    const r = await chrome.runtime.sendMessage({ channel: 'wf-internal', type: 'registerOrigin', origin });
    alert(r?.ok ? `Added. Reload ${origin} and click “Connect extension”.` : `Failed: ${r?.error}`);
    renderSettings();
  };
  view.querySelector('#ai-save').onclick = async () => {
    const cur = (await session()).ai || {};
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
db.on((e) => {
  if (state.screen === 'settings') return;
  if (state.screen === 'home' && document.activeElement?.id === 'instruction') return;
  if (['tasks', 'activity', 'approvals', 'employees'].includes(e.store)) { clearTimeout(t); t = setTimeout(render, 250); }
});
chrome.tabs.onActivated.addListener(() => { if (state.screen === 'home') render(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (state.screen === 'home' && info.status === 'complete') render(); });
chrome.storage.onChanged.addListener(() => renderStatus());

render();
runtime.recover();
