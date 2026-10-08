import { esc, icon, avatar, statusBadge, timeAgo, fmtDateTime, fmtHours, sysIcon, refreshIcons, toast, modal, confirmDialog, download, emptyState, md } from '../ui.js';
import { SYSTEMS, SYSTEM_GROUPS, SYSTEM_SCOPES, SCOPE_LABELS, SENSITIVE_SCOPES, DEFAULT_SCOPE_LEVELS, TOOL_MAP, TOOLS, allSystems, systemUrl, systemForUrl, systemOrigins, hostOf } from '../../extension/core/catalog.js';
import { validateEmployee, scheduleNext, normalizeTriggers } from '../../extension/core/employee.js';
import { MEMORY_KINDS, addMemory, employeeMemory, retrieve } from '../../extension/core/memory.js';
import { modifyEmployee, restoreVersion } from '../../extension/core/modifier.js';
import { computeStats } from '../../extension/core/reports.js';
import { clone, now, truncate } from '../../extension/core/util.js';
import { renderWorkflow, openScriptEditor, persist, employeeSystemIds, systemName, systemLogos } from './workflow.js';
import { activityTable, bindActivityRows } from './activity.js';
import { openConnectDialog } from './systems.js';
import { bridge } from '../bridge.js';

const LEVELS = ['allow', 'approval', 'deny'];
const LEVEL_LABEL = { allow: 'Allow', approval: 'Needs approval', deny: 'No access' };
const LEVEL_SHORT = { allow: 'Allow', approval: 'Approval', deny: 'No access' };

/**
 * The level a scope resolves to for one system, following the core policy:
 * missing → deny; script approval or the workspace "approve all" setting lifts
 * allowed click / type actions to approval.
 */
function scopeLevel(employee, sys, scope, { script, settings } = {}) {
  let level = employee.permissions?.[sys]?.[scope] || 'deny';
  if (level === 'allow' && SENSITIVE_SCOPES.has(scope) && (script?.approval?.required || settings?.approveAllOutbound)) level = 'approval';
  return level;
}

/** Knowledge files are readable only with files.read and at least one granted collection. */
function filesLevel(employee) {
  return (employee.collections || []).length ? employee.permissions?.files?.read || 'deny' : 'deny';
}

const lvlTag = (level, label = LEVEL_SHORT[level]) => `<span class="small strong lvl-${level}">${esc(label)}</span>`;
const domainsOf = (employee) => employee.browser?.domains || [];

const TABS = [['overview', 'Overview'], ['chat', 'Chat'], ['scripts', 'Scripts'], ['workflows', 'Workflows'], ['memory', 'Memory'], ['tools', 'Tools'], ['files', 'Files'], ['systems', 'Systems'], ['permissions', 'Permissions'], ['activity', 'Activity'], ['performance', 'Performance']];

export default async function profile(ctx) {
  const { el, app, params, navigate } = ctx;
  const tab = TABS.some(([t]) => t === params.tab) ? params.tab : 'overview';
  let employee = await app.db.get('employees', params.id);
  if (!employee) {
    el.innerHTML = `<div class="page">${emptyState('user-x', 'Employee not found', 'It may have been deleted.', '<a class="btn" href="#/employees">Back to employees</a>')}</div>`;
    return;
  }
  el.innerHTML = `<div class="page"><a class="back" href="#/employees">${icon('arrow-left')} Back to employees</a><div id="head"></div>
    <div class="tabs">${TABS.map(([t, l]) => `<a href="#/employees/${employee.id}/${t}" class="${t === tab ? 'active' : ''}">${l}</a>`).join('')}</div><div id="tab"></div></div>`;
  const head = el.querySelector('#head');
  const host = el.querySelector('#tab');
  const reload = async () => { employee = await app.db.get('employees', params.id); return employee; };

  const renderHead = async () => {
    const [tasks, conns] = await Promise.all([app.db.byIndex('tasks', 'employeeId', employee.id), app.getConnections()]);
    const sysIds = employeeSystemIds(employee, conns);
    const live = tasks.find((t) => ['running', 'waiting_approval', 'queued'].includes(t.status));
    head.innerHTML = `<div class="page-head">
      <div class="row gap-16">${avatar(employee, 'avatar-lg')}<div><div class="row"><h1>${esc(employee.name)}</h1>${statusBadge(employee.status === 'active' && live ? 'working' : employee.status)}</div>
      <p class="muted">${esc(employee.role)} · v${employee.version} · ${employee.scripts.length} scripts · created ${timeAgo(employee.createdAt)}</p>
      ${sysIds.length ? `<a class="row gap-6 mt-8 small muted" href="#/employees/${employee.id}/systems" style="text-decoration:none">${systemLogos(sysIds, conns, 8)}<span>Works in ${esc(sysIds.map((id) => systemName(id, conns)).join(', '))}</span></a>` : ''}</div></div>
      <div class="row wrap">
        ${employee.status === 'draft' ? `<button class="btn" id="deploy">${icon('rocket')} Deploy</button>` : employee.status === 'paused' ? `<button class="btn" id="resume">${icon('play')} Resume</button>` : `<button class="btn" id="pause">${icon('pause')} Pause</button>`}
        <button class="btn btn-icon" id="export" title="Export employee JSON">${icon('download')}</button>
        <button class="btn btn-icon btn-danger" id="delete" title="Delete employee">${icon('trash-2')}</button>
        <button class="btn btn-primary" id="run">${icon('play')} Run task</button>
      </div></div>`;
    head.querySelector('#run').onclick = () => runTaskDialog(app, employee);
    head.querySelector('#deploy')?.addEventListener('click', async () => {
      const e = clone(employee);
      e.status = 'active';
      e.triggers.forEach((t) => { if (t.type === 'schedule') { t.enabled = true; t.nextRunAt = scheduleNext(t); } });
      await app.db.put('employees', e);
      toast(`${e.name} deployed`, 'success');
    });
    head.querySelector('#pause')?.addEventListener('click', () => app.runtime.setEmployeeStatus(employee.id, 'paused'));
    head.querySelector('#resume')?.addEventListener('click', () => app.runtime.setEmployeeStatus(employee.id, 'active'));
    head.querySelector('#export').onclick = () => download(`${employee.name.toLowerCase()}-${employee.role.toLowerCase().replace(/\W+/g, '-')}.json`, JSON.stringify({ ...employee, collections: [] }, null, 2));
    head.querySelector('#delete').onclick = async () => {
      if (!(await confirmDialog(`Delete ${employee.name}? Its memory, schedules and versions are deleted. Activity history is kept for audit.`, { danger: true, confirm: 'Delete' }))) return;
      for (const t of tasks) if (!['completed', 'failed', 'cancelled'].includes(t.status)) await app.runtime.cancelTask(t.id);
      await app.db.deleteWhere('memory', 'employeeId', employee.id);
      await app.db.deleteWhere('schedules', 'employeeId', employee.id);
      await app.db.deleteWhere('versions', 'employeeId', employee.id);
      await app.db.delete('employees', employee.id);
      toast('Employee deleted');
      navigate('/employees');
    };
    refreshIcons();
  };

  const tabs = { overview, chat, scripts, workflows, memory, tools, files, systems, permissions, activity, performance };
  const renderTab = async () => { if (ctx.isCurrent()) { await tabs[tab]({ host, app, employee, reload, ctx, navigate }); refreshIcons(); } };
  await renderHead();
  await renderTab();
  ctx.watch(['employees'], async () => { if (!(await reload())) return navigate('/employees'); renderHead(); if (!['chat'].includes(tab)) renderTab(); });
  ctx.watch(['tasks'], () => renderHead(), 600);
  ctx.watch(['connections'], () => { renderHead(); if (['systems', 'permissions', 'tools', 'scripts', 'workflows', 'overview'].includes(tab)) renderTab(); }, 400);
  if (['overview', 'activity', 'performance', 'workflows'].includes(tab)) ctx.watch(['tasks', 'activity', 'versions', 'approvals'], () => renderTab(), 700);
}

// ------------------------------------------------------------ Run task
export async function runTaskDialog(app, employee, { input = '' } = {}) {
  if (!(await app.aiReady())) return toast('Configure the AI engine first (Settings → AI Engine).', 'error');
  const conns = await app.getConnections();
  const mine = employeeSystemIds(employee, conns);
  const names = mine.map((id) => systemName(id, conns));
  let tabs = [];
  if (bridge.paired) { try { tabs = (await bridge.tabs() || []).filter((t) => /^https?:\/\//i.test(t.url || '')); } catch { tabs = []; } }
  const tabSystem = (t) => systemForUrl(t.url, conns);
  // Tabs inside this employee's systems first, then the active tab.
  tabs.sort((a, b) => (mine.includes(tabSystem(b)) ? 1 : 0) - (mine.includes(tabSystem(a)) ? 1 : 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0));
  const tabLabel = (t) => { const sid = tabSystem(t); return `${truncate(t.title || t.url, 60)} — ${sid ? systemName(sid, conns) : hostOf(t.url)}`; };
  const entries = [
    ...employee.triggers.map((t) => ({ value: `trg:${t.id}`, label: `Trigger · ${t.label}`, entry: t.entryScript, input: t.input })),
    ...employee.scripts.map((s) => ({ value: `scr:${s.id}`, label: `Start at · ${s.name}`, entry: s.id })),
  ];
  const defaultHelp = mine.length
    ? `No tab needed: ${esc(employee.name)} opens ${esc(names.join(', '))} in a new working tab with browser_open. Pick a tab to start where you already are, e.g. an open email or record.`
    : `${esc(employee.name)} has no systems yet, so a tab is only useful for reading websites listed under Permissions → Other websites.`;
  const tabHelp = (t) => {
    if (!t) return defaultHelp;
    const sid = tabSystem(t);
    if (sid && mine.includes(sid)) return `${sysIcon(sid, true, systemName(sid, conns))} In ${esc(systemName(sid, conns))}: ${SYSTEM_SCOPES.map((sc) => `${SCOPE_LABELS[sc]} ${lvlTag(scopeLevel(employee, sid, sc, { settings: app.settings }))}`).join(' · ')}`;
    if (domainsOf(employee).includes(hostOf(t.url))) return `${icon('globe')} Other website: ${esc(employee.name)} may read and navigate here, but not click or type.`;
    return `<span class="s-wait">${icon('alert-triangle')} ${esc(sid ? systemName(sid, conns) : hostOf(t.url))} is not one of ${esc(employee.name)}'s systems. It will be blocked in this tab until you add it under Permissions.</span>`;
  };
  modal({
    title: `Run ${employee.name}`,
    subtitle: 'Creates a real task executed by the AI engine. Clicks and typing that need approval wait in the Approval Center.',
    body: `<div class="form-grid">
      <label class="field"><span>Instruction</span><textarea class="textarea" id="rt-input" rows="5" placeholder="e.g. Process the new lead: Jane Doe, jane@acme.io, VP Sales at Acme (acme.io)">${esc(input)}</textarea></label>
      <label class="field"><span>Entry point</span><select class="select" id="rt-entry">${entries.map((e) => `<option value="${e.value}" ${e.entry === employee.entryScript && e.value.startsWith('scr') ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
      ${bridge.paired ? `<label class="field"><span>Working tab <span class="muted">(optional)</span></span><select class="select" id="rt-tab"><option value="">Let the employee open its systems itself</option>${tabs.map((t) => `<option value="${t.id}">${esc(tabLabel(t))}</option>`).join('')}</select><span class="help row wrap gap-4" id="rt-tab-help">${defaultHelp}</span></label>`
    : mine.length ? `<div class="callout warn">${icon('puzzle')}<div class="small">${esc(employee.name)} works in ${esc(names.join(', '))} through the WorkForge browser extension, using your own signed-in browser. <a href="#/extension">Install and pair the extension</a> first — without it, every step in those systems fails.</div></div>` : ''}
      ${employee.status === 'draft' ? `<div class="callout warn">${icon('flask-conical')}<div class="small">${esc(employee.name)} is a draft — this run is a real test run with real tools and approvals.</div></div>` : ''}
    </div>`,
    onMount(m) {
      const sel = m.querySelector('#rt-tab');
      if (!sel) return;
      sel.onchange = () => { m.querySelector('#rt-tab-help').innerHTML = tabHelp(tabs.find((x) => x.id === Number(sel.value))); refreshIcons(); };
    },
    actions: [
      { label: 'Cancel' },
      { label: 'Run task', primary: true, icon: 'play', onClick: async (m) => {
        if (employee.status === 'paused') throw new Error(`${employee.name} is paused. Resume it first.`);
        const text = m.querySelector('#rt-input').value.trim();
        const sel = entries.find((e) => e.value === m.querySelector('#rt-entry').value);
        const tabId = Number(m.querySelector('#rt-tab')?.value || 0);
        let browser = null;
        if (tabId) {
          const t = tabs.find((x) => x.id === tabId);
          if (!t) throw new Error('That tab is no longer available. Pick another tab or let the employee open its systems itself.');
          const origin = new URL(t.url).origin;
          const host = new URL(origin).host;
          const g = await bridge.grantHosts([`${origin}/*`]);
          if (!g?.granted) {
            throw new Error(g?.pending
              ? `Approve access to ${host} in the WorkForge extension window that just opened, then click Run task again.`
              : `The WorkForge extension does not have access to ${host}, so the employee cannot work in that tab.`);
          }
          browser = { tabId, url: t.url, title: t.title, origin };
        }
        const task = await app.runtime.createTask(employee, { input: text || sel?.input || '', title: text ? undefined : sel?.label, trigger: 'manual', entryScript: sel?.entry, browser });
        toast(`Task started: ${task.title}`, 'success');
      } },
    ],
  });
}

// ------------------------------------------------------------ Overview
async function overview({ host, app, employee }) {
  const [tasks, versions] = await Promise.all([app.db.byIndex('tasks', 'employeeId', employee.id), app.db.byIndex('versions', 'employeeId', employee.id)]);
  tasks.sort((a, b) => b.createdAt - a.createdAt);
  const live = tasks.find((t) => ['running', 'waiting_approval', 'queued'].includes(t.status));
  const tests = employee.tests;
  host.innerHTML = `<div class="grid-2" style="grid-template-columns: 1.35fr 1fr; align-items:start">
    <div class="col gap-16">
      ${live ? liveTaskCard(employee, live) : ''}
      <div class="card card-pad col">
        <h3>About</h3><p class="small">${esc(employee.summary)}</p>
        ${employee.request ? `<details><summary class="small muted" style="cursor:pointer">Original request</summary><pre class="light mt-8">${esc(employee.request)}</pre></details>` : ''}
        <div class="grid-2 mt-8">
          <div><div class="section-title mb-8">Goals</div>${employee.goals.length ? `<ul class="small" style="padding-left:18px;margin:0">${employee.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '<span class="small muted">—</span>'}</div>
          <div><div class="section-title mb-8">Rules</div>${employee.rules.length ? `<ul class="small" style="padding-left:18px;margin:0">${employee.rules.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '<span class="small muted">—</span>'}</div>
        </div>
        ${employee.instructions ? `<div><div class="section-title mb-8 mt-8">Standing instructions</div><p class="small" style="white-space:pre-wrap">${esc(employee.instructions)}</p></div>` : ''}
      </div>
      <div class="card"><div class="card-head"><h3>Triggers &amp; schedules</h3><button class="btn btn-sm" id="add-trigger">${icon('plus')} Add schedule</button></div>
        <div class="card-body col">${employee.triggers.map((t) => `<div class="between"><div class="row">${icon(t.type === 'schedule' ? 'clock' : t.type === 'browser' ? 'globe' : 'mouse-pointer-click')}<div><div class="small strong">${esc(t.label)}</div><div class="tiny muted">${t.type === 'schedule' ? (t.schedule.everyMinutes ? `Every ${t.schedule.everyMinutes} min` : `Daily at ${t.schedule.dailyAt}`) + (t.enabled && t.nextRunAt ? ` · next ${timeAgo(t.nextRunAt)}` : '') : t.type === 'browser' ? 'Started from the browser extension' : 'Run on demand'}${t.input ? ` · “${esc(truncate(t.input, 70))}”` : ''}</div></div></div>
          <div class="row">${t.type === 'schedule' ? `<label class="toggle" title="Enable schedule"><input type="checkbox" data-trg-toggle="${t.id}" ${t.enabled ? 'checked' : ''}><span></span></label><button class="btn btn-xs btn-ghost" data-trg-del="${t.id}">${icon('trash-2')}</button>` : ''}</div></div>`).join('')}
          <p class="help">Schedules run while WorkForge is open in a browser tab (static hosting has no server). Follow-ups scheduled by the employee appear under Tasks.</p>
        </div></div>
      <div class="card"><div class="card-head"><h3>Version history</h3><span class="small muted">Current v${employee.version}</span></div><div class="card-body col">
        ${versions.length ? versions.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map((v) => `<div class="between"><div><div class="small strong">v${v.version} <span class="muted" style="font-weight:400">· ${fmtDateTime(v.createdAt)}</span></div><div class="tiny muted">${esc(truncate(v.reason, 110))}</div></div><button class="btn btn-xs" data-restore="${v.id}">${icon('rotate-ccw')} Restore</button></div>`).join('') : '<p class="small muted">Changes made through Chat, the script editor or Permissions are versioned here.</p>'}
      </div></div>
    </div>
    <div class="col gap-16">
      <div class="card"><div class="card-head"><h3>Recent tasks</h3><a class="small" href="#/tasks">All tasks</a></div><div class="card-body">
        ${tasks.length ? `<div class="feed">${tasks.slice(0, 8).map((t) => `<a class="feed-item" href="#/tasks/${t.id}" style="color:inherit;text-decoration:none"><div class="grow"><div class="small strong ellipsis">${esc(t.title)}</div><div class="time">${timeAgo(t.createdAt)} · ${t.scriptRuns.length} script runs${t.origin === 'extension' ? ' · extension' : ''}</div></div>${statusBadge(t.status)}</a>`).join('')}</div>` : `<p class="small muted">No tasks yet. <button class="link-btn" id="first-run">Run the first task</button></p>`}
      </div></div>
      <div class="card"><div class="card-head"><h3>Validation</h3><button class="btn btn-sm" id="revalidate">${icon('refresh-cw')} Re-run checks</button></div><div class="card-body col gap-6">
        ${tests ? tests.results.map((r) => `<div class="row-top small"><span class="${r.severity === 'pass' ? 's-ok' : r.severity === 'warn' ? 's-wait' : 's-err'}">${icon(r.severity === 'pass' ? 'check-circle-2' : r.severity === 'warn' ? 'alert-triangle' : 'x-circle')}</span><div><div class="strong">${esc(r.name)}</div><div class="tiny muted">${esc(r.detail)}</div></div></div>`).join('') : ''}
        <div class="tiny muted">Last run ${tests ? timeAgo(tests.ranAt) : 'never'}</div>
      </div></div>
    </div></div>`;

  host.querySelector('#first-run')?.addEventListener('click', () => runTaskDialog(app, employee));
  host.querySelector('#revalidate').onclick = async () => {
    const e = clone(employee);
    e.tests = validateEmployee(e, { connections: await app.connectionMap(), collections: await app.db.all('collections') });
    await app.db.put('employees', e);
    toast(e.tests.passed ? `Checks passed (${e.tests.warnings} warnings)` : 'Some checks failed', e.tests.passed ? 'success' : 'error');
  };
  host.querySelectorAll('[data-trg-toggle]').forEach((t) => t.onchange = async () => {
    const e = clone(employee);
    const trg = e.triggers.find((x) => x.id === t.dataset.trgToggle);
    trg.enabled = t.checked;
    trg.nextRunAt = t.checked ? scheduleNext(trg) : null;
    await app.db.put('employees', e);
    toast(t.checked ? `Schedule enabled${e.status !== 'active' ? ' (runs once the employee is deployed)' : ''}` : 'Schedule disabled', 'success');
  });
  host.querySelectorAll('[data-trg-del]').forEach((b) => b.onclick = async () => {
    const e = clone(employee);
    e.triggers = e.triggers.filter((x) => x.id !== b.dataset.trgDel);
    await persist(app, employee, e, 'Removed schedule');
  });
  host.querySelectorAll('[data-restore]').forEach((b) => b.onclick = async () => {
    if (!(await confirmDialog('Restore this version? The current configuration is saved as a new version first.', { confirm: 'Restore' }))) return;
    await restoreVersion(app.db, b.dataset.restore);
    toast('Version restored', 'success');
  });
  host.querySelector('#add-trigger').onclick = () => modal({
    title: 'Add schedule',
    body: `<div class="form-grid">
      <label class="field"><span>Label</span><input class="input" id="t-label" placeholder="Morning lead check"></label>
      <div class="form-row"><label class="field"><span>Every N minutes</span><input class="input" type="number" min="5" id="t-every" placeholder="e.g. 60"></label><label class="field"><span>…or daily at</span><input class="input" type="time" id="t-daily"></label></div>
      <label class="field"><span>Instruction for each run</span><textarea class="textarea" id="t-input" rows="3" placeholder="Check Gmail for new leads from the last hour and process them."></textarea></label>
      <label class="field"><span>Start at script</span><select class="select" id="t-entry">${employee.scripts.map((s) => `<option value="${s.id}" ${s.id === employee.entryScript ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    </div>`,
    actions: [{ label: 'Cancel' }, { label: 'Add schedule', primary: true, onClick: async (m) => {
      const every = Number(m.querySelector('#t-every').value) || 0;
      const daily = m.querySelector('#t-daily').value;
      if (!every && !daily) throw new Error('Set an interval or a daily time');
      const [t] = normalizeTriggers([{ type: 'schedule', label: m.querySelector('#t-label').value || 'Scheduled run', input: m.querySelector('#t-input').value, entryScript: m.querySelector('#t-entry').value, schedule: { everyMinutes: every, dailyAt: daily } }], employee.entryScript, new Set(employee.scripts.map((s) => s.id))).filter((x) => x.type === 'schedule');
      t.enabled = true;
      t.nextRunAt = scheduleNext(t);
      const e = clone(employee);
      e.triggers.push(t);
      await persist(app, employee, e, `Added schedule “${t.label}”`);
    } }],
  });
}

function liveTaskCard(employee, task) {
  const current = task.current ? employee.scripts.find((s) => s.id === task.current.scriptId) : null;
  return `<div class="card card-pad" style="border-color:#c7d2fe">
    <div class="between"><div><div class="tiny muted">Current task</div><a class="strong" href="#/tasks/${task.id}">${esc(task.title)}</a></div>${statusBadge(task.status)}</div>
    <div class="steps-mini mt-12">
      ${task.scriptRuns.map((r) => `<div class="s"><span class="${r.status === 'success' ? 's-ok' : 's-err'}">${icon(r.status === 'success' ? 'check' : 'x')}</span>${esc(r.name)} <span class="muted ellipsis">— ${esc(truncate(r.summary, 90))}</span></div>`).join('')}
      ${current ? `<div class="s ${task.status === 'waiting_approval' ? 's-wait' : 's-run'}">${icon(task.status === 'waiting_approval' ? 'pause-circle' : 'loader')}<strong>${esc(current.name)}</strong> ${task.status === 'waiting_approval' ? '<a href="#/approvals">— waiting for approval</a>' : ''}</div>` : ''}
    </div></div>`;
}

// ------------------------------------------------------------ Chat
async function chat({ host, app, employee, reload }) {
  const SUGGEST = ['Add a three-day follow-up for leads that don’t reply.', 'Don’t allow this employee to send emails without approval.', 'Use the pricing document when answering customers.', 'Add a Slack notification after every qualified lead.', 'What does this employee do when a script fails?'];
  host.innerHTML = `<div class="card chat">
    <div class="card-head"><div><h3>${icon('message-square')} Instruct ${esc(employee.name)}</h3><div class="tiny muted">The AI engine turns your instructions into real configuration changes (versioned), answers questions, or starts tasks.</div></div><button class="btn btn-sm" id="undo">${icon('undo-2')} Undo last change</button></div>
    <div class="chat-log" id="log"></div>
    <div class="suggestions">${SUGGEST.map((s) => `<button data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div class="chat-input"><textarea class="textarea" id="msg" rows="1" placeholder="e.g. Add another follow-up after three days"></textarea><button class="btn btn-primary" id="send">${icon('send')}</button></div>
  </div>`;
  const log = host.querySelector('#log');
  const renderLog = async () => {
    const mem = (await employeeMemory(app.db, employee.id)).filter((m) => m.kind === 'conversation').sort((a, b) => a.createdAt - b.createdAt);
    log.innerHTML = mem.length ? mem.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}">${m.role === 'user' ? esc(m.content) : md(m.content)}${m.results?.length ? `<div class="ops">${m.results.map((r) => `<div class="${r.ok ? 's-ok' : 's-err'}">${icon(r.ok ? 'check' : 'x')} ${esc(r.message)}</div>`).join('')}</div>` : ''}</div>`).join('')
      : `<div class="empty">${icon('sparkles')}<p class="small">Tell ${esc(employee.name)} what to change. Example: “Add a Salesforce update after every qualified lead.”</p></div>`;
    refreshIcons();
    log.scrollTop = log.scrollHeight;
  };
  await renderLog();
  const send = async (text) => {
    if (!text.trim()) return;
    if (!(await app.aiReady())) return toast('Configure the AI engine first', 'error');
    const input = host.querySelector('#msg');
    input.value = '';
    const history = (await employeeMemory(app.db, employee.id)).filter((m) => m.kind === 'conversation').sort((a, b) => a.createdAt - b.createdAt).map((m) => ({ role: m.role, text: m.content }));
    await addMemory(app.db, employee.id, 'conversation', text, { role: 'user', source: 'chat' });
    await renderLog();
    log.insertAdjacentHTML('beforeend', `<div class="msg ai" id="thinking"><span class="spinner sm"></span> Working on it…</div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const current = await reload();
      const r = await modifyEmployee({ db: app.db, ai: await app.getAI(), employee: current, instruction: text, history, collections: await app.db.all('collections'), connections: await app.connectionMap() });
      await addMemory(app.db, employee.id, 'conversation', r.reply || (r.changed ? 'Done.' : 'No changes were needed.'), { role: 'ai', source: 'chat', results: r.results.map(({ op, ok, message }) => ({ op, ok, message })) });
      for (const t of r.runTasks) {
        const emp = await reload();
        await app.runtime.createTask(emp, { input: t.input, entryScript: t.entryScript, trigger: 'chat' });
      }
      if (r.changed) toast(`${employee.name} updated (v${r.employee.version})`, 'success');
    } catch (e) {
      await addMemory(app.db, employee.id, 'conversation', `Error: ${e.message}`, { role: 'ai', source: 'chat' });
    }
    await renderLog();
  };
  host.querySelector('#send').onclick = () => send(host.querySelector('#msg').value);
  host.querySelector('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
  host.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => { host.querySelector('#msg').value = b.dataset.s; host.querySelector('#msg').focus(); });
  host.querySelector('#undo').onclick = async () => {
    const versions = (await app.db.byIndex('versions', 'employeeId', employee.id)).sort((a, b) => b.createdAt - a.createdAt);
    if (!versions.length) return toast('Nothing to undo');
    await restoreVersion(app.db, versions[0].id);
    await addMemory(app.db, employee.id, 'conversation', `Restored the configuration from before: “${truncate(versions[0].reason, 120)}”.`, { role: 'ai', source: 'chat' });
    toast('Change undone', 'success');
    renderLog();
  };
}

// ------------------------------------------------------------ Scripts
async function scripts({ host, app, employee }) {
  const byId = Object.fromEntries(employee.scripts.map((s) => [s.id, s]));
  host.innerHTML = `<div class="between mb-16"><p class="muted small">${employee.scripts.length} generated scripts. The AI engine executes one script at a time and chooses the next from its transitions.</p><button class="btn btn-primary btn-sm" id="add">${icon('plus')} Add script</button></div>
  <div class="col gap-16">${employee.scripts.map((s, i) => `<div class="script-card">
    <div class="between"><div class="row"><span class="num">${i + 1}</span><div><div class="strong">${esc(s.name)} ${s.id === employee.entryScript ? '<span class="badge badge-primary">entry</span>' : ''} ${s.approval.required ? '<span class="badge badge-warning">approval required</span>' : ''}</div><div class="tiny muted mono">${esc(s.id)}</div></div></div><button class="btn btn-sm" data-edit="${s.id}">${icon('pencil')} Edit</button></div>
    <p class="small">${esc(s.description)}</p>
    <dl class="kv">
      <dt>Purpose</dt><dd>${esc(s.purpose || '—')}</dd>
      <dt>Trigger</dt><dd>${esc(s.trigger || '—')}</dd>
      <dt>Inputs</dt><dd>${s.inputs.map((f) => `<span class="tag">${esc(f.name)}: ${esc(f.type)}</span>`).join('') || '—'}</dd>
      <dt>Outputs</dt><dd>${s.outputs.map((f) => `<span class="tag">${esc(f.name)}: ${esc(f.type)}</span>`).join('') || '—'}</dd>
      <dt>Conditions</dt><dd>${s.conditions.map(esc).join('<br>') || '—'}</dd>
      <dt>Tools</dt><dd>${s.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">internal only</span>'}</dd>
      <dt>Permissions</dt><dd>${[...new Set(s.tools.map((t) => { const tool = TOOL_MAP[t]; const lvl = evaluatePermission(employee, t, { method: 'GET' }, { script: s, settings: app.settings }).level; return `${SYSTEMS[tool.system]?.name || tool.system} ${tool.scope}: <span class="lvl-${lvl}">${lvl}</span>`; }))].join(' · ') || '—'}</dd>
      <dt>Dependencies</dt><dd>${s.dependencies.map((d) => esc(byId[d]?.name || d)).join(', ') || '—'}</dd>
      <dt>Next scripts</dt><dd>${s.next.map((n) => `${esc(byId[n.script]?.name || n.script)}${n.condition ? ` <span class="muted">(${esc(n.condition)})</span>` : ''}`).join('<br>') || '<span class="badge badge-success">END</span>'}</dd>
      <dt>On failure</dt><dd>${esc(s.failure.strategy)}${s.failure.strategy === 'retry' ? ` ×${s.failure.maxRetries}` : ''}${s.failure.escalateTo ? ` → ${esc(byId[s.failure.escalateTo]?.name || s.failure.escalateTo)}` : ''}</dd>
      <dt>Est. manual time</dt><dd>${s.estimatedMinutes} min</dd>
    </dl>
    ${s.instructions ? `<details><summary class="small muted" style="cursor:pointer">Instructions</summary><pre class="light mt-8">${esc(s.instructions)}</pre></details>` : ''}
  </div>`).join('')}</div>`;
  host.querySelector('#add').onclick = () => openScriptEditor(app, employee, null);
  host.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openScriptEditor(app, employee, b.dataset.edit));
}

// ------------------------------------------------------------ Workflows
async function workflows({ host, app, employee }) {
  const tasks = await app.db.byIndex('tasks', 'employeeId', employee.id);
  const live = tasks.find((t) => t.status === 'running' || t.status === 'waiting_approval');
  host.innerHTML = `<div class="card card-pad mb-16"><div class="row">${icon('sparkles')}<input class="input grow" id="ai-mod" placeholder="Ask the AI engine to change this workflow — e.g. “Add another follow-up after three days”"><button class="btn btn-primary" id="ai-go">Apply</button></div><div class="small mt-8" id="ai-out"></div></div>
    <div class="between mb-8"><span class="small muted">Click a script to edit it. Dashed lines are loops; labels are the decision conditions the AI engine evaluates.${live ? ' The highlighted node is executing now.' : ''}</span><button class="btn btn-sm" id="add">${icon('plus')} Add script</button></div>
    <div id="wf"></div>`;
  renderWorkflow(host.querySelector('#wf'), employee, { running: live?.current?.scriptId, onSelect: (id) => openScriptEditor(app, employee, id) });
  host.querySelector('#add').onclick = () => openScriptEditor(app, employee, null);
  const go = async () => {
    const text = host.querySelector('#ai-mod').value.trim();
    if (!text) return;
    if (!(await app.aiReady())) return toast('Configure the AI engine first', 'error');
    const out = host.querySelector('#ai-out');
    out.innerHTML = '<span class="spinner sm"></span> Modifying the architecture…';
    try {
      const r = await modifyEmployee({ db: app.db, ai: await app.getAI(), employee, instruction: text, collections: await app.db.all('collections'), connections: await app.connectionMap(), actor: 'workflow editor' });
      for (const t of r.runTasks) await app.runtime.createTask(r.employee, { input: t.input, entryScript: t.entryScript, trigger: 'workflow editor' });
      out.innerHTML = `${md(r.reply)}${r.results.map((x) => `<div class="${x.ok ? 's-ok' : 's-err'} small">${x.ok ? '✓' : '✕'} ${esc(x.message)}</div>`).join('')}`;
      await addMemory(app.db, employee.id, 'conversation', text, { role: 'user', source: 'workflow' });
      await addMemory(app.db, employee.id, 'conversation', r.reply, { role: 'ai', source: 'workflow', results: r.results.map(({ op, ok, message }) => ({ op, ok, message })) });
    } catch (e) { out.innerHTML = `<span class="s-err">${esc(e.message)}</span>`; }
  };
  host.querySelector('#ai-go').onclick = go;
  host.querySelector('#ai-mod').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// ------------------------------------------------------------ Memory
async function memory({ host, app, employee }) {
  const items = await employeeMemory(app.db, employee.id);
  const groups = Object.keys(MEMORY_KINDS).map((k) => [k, items.filter((m) => m.kind === k)]);
  host.innerHTML = `<div class="grid-2" style="grid-template-columns: 1.4fr 1fr; align-items:start">
    <div class="col gap-16">${groups.map(([k, list]) => `<div class="card"><div class="card-head"><h3>${MEMORY_KINDS[k]}</h3><span class="badge">${list.length}</span></div>
      <div class="card-body">${k === 'files' ? '' : list.length ? `<div class="feed">${list.slice(0, 30).map((m) => `<div class="feed-item"><div class="grow"><div class="small" style="white-space:pre-wrap">${esc(truncate(m.content, 600))}</div><div class="time">${timeAgo(m.createdAt)} · ${esc(m.source || '')}${m.role ? ` · ${esc(m.role)}` : ''}</div></div><button class="btn btn-xs btn-ghost" data-del="${m.id}" title="Forget">${icon('trash-2')}</button></div>`).join('')}</div>${list.length > 30 ? `<p class="tiny muted mt-8">+${list.length - 30} more</p>` : ''}` : '<p class="small muted">Empty</p>'}</div></div>`).join('')}
      <div class="card"><div class="card-head"><h3>Connected file knowledge</h3><a class="small" href="#/employees/${employee.id}/files">Manage</a></div><div class="card-body small">${employee.collections.length ? `${employee.collections.length} collection(s) searchable by this employee.` : 'No collections granted.'}</div></div>
    </div>
    <div class="col gap-16">
      <div class="card card-pad form-grid"><h3>Add memory</h3>
        <select class="select" id="m-kind">${['instructions', 'business', 'long_term', 'system'].map((k) => `<option value="${k}">${MEMORY_KINDS[k]}</option>`).join('')}</select>
        <textarea class="textarea" id="m-text" rows="4" placeholder="e.g. Our ideal customer has 50–500 employees and uses Salesforce."></textarea>
        <button class="btn btn-primary" id="m-add">${icon('plus')} Save to memory</button></div>
      <div class="card card-pad form-grid"><h3>Test retrieval</h3><p class="help">See exactly what the AI engine retrieves for a query (BM25 over memory and granted files).</p>
        <div class="row"><input class="input" id="m-q" placeholder="pricing for enterprise plan"><button class="btn" id="m-search">${icon('search')}</button></div><div id="m-res" class="col gap-6"></div></div>
    </div></div>`;
  host.querySelector('#m-add').onclick = async () => {
    const text = host.querySelector('#m-text').value.trim();
    if (!text) return;
    await addMemory(app.db, employee.id, host.querySelector('#m-kind').value, text, { source: 'user' });
    toast('Saved to memory', 'success');
    memory({ host, app, employee });
  };
  host.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await app.db.delete('memory', b.dataset.del); memory({ host, app, employee }); });
  host.querySelector('#m-search').onclick = async () => {
    const r = await retrieve(app.db, employee, host.querySelector('#m-q').value, { k: 8 });
    host.querySelector('#m-res').innerHTML = r.length ? r.map((x) => `<div class="card" style="padding:10px"><div class="between tiny muted"><span>${x.type === 'file' ? `File · ${esc(x.fileName)}` : esc(MEMORY_KINDS[x.kind] || x.kind)}</span><span>score ${x.score.toFixed(2)}</span></div><div class="small mt-4">${esc(truncate(x.text, 300))}</div></div>`).join('') : '<p class="small muted">No matches</p>';
  };
  refreshIcons();
}

// ------------------------------------------------------------ Tools
async function tools({ host, app, employee }) {
  const conns = await app.connectionMap();
  const used = new Set(employee.scripts.flatMap((s) => s.tools));
  const list = TOOLS.filter((t) => used.has(t.name) || t.internal || (t.system === 'files' && employee.collections.length));
  host.innerHTML = `<div class="card"><div class="table-wrap"><table class="log-table"><thead><tr><th>Tool</th><th>System</th><th>Scope</th><th>Permission</th><th>Used by</th><th>Connection</th></tr></thead><tbody>
    ${list.map((t) => {
    const lvl = t.internal ? 'allow' : evaluatePermission(employee, t.name, { method: 'GET' }, { settings: app.settings }).level;
    const connId = SYSTEMS[t.system]?.connection;
    const by = employee.scripts.filter((s) => s.tools.includes(t.name)).map((s) => s.name);
    return `<tr><td><div class="mono small strong">${t.name}</div><div class="tiny muted">${esc(t.description)}</div></td><td class="small">${t.internal ? 'Internal' : esc(SYSTEMS[t.system]?.name || t.system)}</td><td><span class="tag">${t.scopeFor ? 'read/write' : t.scope}</span></td><td><span class="small strong lvl-${lvl}">${lvl}</span></td><td class="small">${by.length ? by.map(esc).join(', ') : t.internal ? 'All scripts' : '—'}</td><td>${connId ? statusBadge(conns[connId]?.status === 'connected' ? 'connected' : 'disconnected') : t.system === 'browser' ? statusBadge(bridge.paired ? 'connected' : 'disconnected', bridge.paired ? 'Extension' : 'No extension') : '<span class="tiny muted">built-in</span>'}</td></tr>`;
  }).join('')}
  </tbody></table></div></div>`;
}

// ------------------------------------------------------------ Files
async function files({ host, app, employee }) {
  const [collections, allFiles] = await Promise.all([app.db.all('collections'), app.db.all('files')]);
  host.innerHTML = `<div class="card"><div class="card-head"><div><h3>Knowledge access</h3><div class="tiny muted">${esc(employee.name)} can search and read only the collections enabled here.</div></div><a class="btn btn-sm" href="#/files">${icon('folder')} Manage files</a></div>
    <div class="card-body">${collections.length ? collections.map((c) => {
    const n = allFiles.filter((f) => f.collectionId === c.id).length;
    return `<div class="file-row"><span class="file-ic">${icon('folder')}</span><div class="grow"><div class="strong small">${esc(c.name)}</div><div class="tiny muted">${n} file(s) · ${esc(c.description || '')}</div></div><label class="toggle"><input type="checkbox" data-coll="${c.id}" ${employee.collections.includes(c.id) ? 'checked' : ''}><span></span></label></div>`;
  }).join('') : emptyState('folder', 'No knowledge collections', 'Upload documents in Files, then grant this employee read access here.', '<a class="btn btn-primary" href="#/files">Upload files</a>')}</div></div>`;
  host.querySelectorAll('[data-coll]').forEach((t) => t.onchange = async () => {
    const e = clone(employee);
    e.collections = t.checked ? [...new Set([...e.collections, t.dataset.coll])] : e.collections.filter((x) => x !== t.dataset.coll);
    if (e.collections.length) e.permissions.files = { read: 'allow' }; else delete e.permissions.files;
    await persist(app, employee, e, `${t.checked ? 'Granted' : 'Revoked'} access to “${collections.find((c) => c.id === t.dataset.coll)?.name}”`);
  });
}

// ------------------------------------------------------------ Systems
async function systems({ host, app, employee }) {
  const conns = await app.connectionMap();
  const sys = Object.keys(employee.permissions).filter((s) => SYSTEMS[s]);
  const { openConnectDialog } = await import('./systems.js');
  host.innerHTML = sys.length ? `<div class="grid-2">${sys.map((s) => {
    const connId = SYSTEMS[s].connection;
    const c = connId ? conns[connId] : null;
    const ok = connId ? c?.status === 'connected' : s === 'browser' || s === 'web' ? bridge.paired : true;
    return `<div class="int-card"><div class="between"><div class="row">${sysIcon(s)}<div><div class="strong">${esc(SYSTEMS[s].name)}</div><div class="tiny muted">${Object.entries(employee.permissions[s]).map(([k, v]) => `${SCOPE_LABELS[k] || k}: ${v}`).join(' · ')}</div></div></div>${statusBadge(ok ? 'connected' : 'disconnected', ok ? (connId ? `Connected${c?.account ? ` · ${c.account}` : ''}` : s === 'files' ? 'Built-in' : 'Extension connected') : (s === 'browser' || s === 'web') ? 'Needs extension' : 'Not connected')}</div>
      <p class="small muted">${esc(SYSTEMS[s].description)}</p>
      ${!ok ? (connId ? `<button class="btn btn-sm" data-connect="${connId}">${icon('plug')} Connect ${esc(CONNECTIONS[connId].name)}</button>` : '<a class="btn btn-sm" href="#/extension">Set up extension</a>') : ''}</div>`;
  }).join('')}</div>` : emptyState('server', 'No systems', 'This employee only uses internal tools.');
  host.querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => openConnectDialog(app, b.dataset.connect));
}

// ------------------------------------------------------------ Permissions
async function permissions({ host, app, employee }) {
  const sysList = Object.keys(SYSTEMS).filter((s) => s !== 'files');
  const active = sysList.filter((s) => employee.permissions[s]);
  const inactive = sysList.filter((s) => !employee.permissions[s]);
  const sel = (sys, scope) => {
    const v = employee.permissions[sys]?.[scope] || 'deny';
    return `<select class="select select-sm lvl-${v}" data-perm="${sys}:${scope}">${['allow', 'approval', 'deny'].map((l) => `<option value="${l}" ${v === l ? 'selected' : ''}>${l === 'allow' ? 'Allow' : l === 'approval' ? 'Needs approval' : 'No access'}</option>`).join('')}</select>`;
  };
  host.innerHTML = `<div class="grid-2" style="grid-template-columns:1.5fr 1fr;align-items:start">
    <div class="card"><div class="card-head"><div><h3>System permissions</h3><div class="tiny muted">Checked on every tool call. Employees never gain access automatically.</div></div>
      <select class="select select-sm" style="width:180px" id="add-sys"><option value="">+ Add system</option>${inactive.map((s) => `<option value="${s}">${esc(SYSTEMS[s].name)}</option>`).join('')}</select></div>
      <div class="table-wrap"><table class="perm-table"><thead><tr><th>System</th><th>Scopes</th><th></th></tr></thead><tbody>
      ${active.map((s) => `<tr><td><div class="row">${sysIcon(s, true)}<span class="strong small">${esc(SYSTEMS[s].name)}</span></div></td><td><div class="row wrap gap-6">${SYSTEMS[s].scopes.map((sc) => `<label class="row gap-4 small"><span class="muted">${SCOPE_LABELS[sc]}</span>${sel(s, sc)}</label>`).join('')}</div></td><td><button class="btn btn-xs btn-ghost" data-revoke="${s}" title="Remove all access">${icon('x')}</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted small">No system access</td></tr>'}
      <tr><td><div class="row">${sysIcon('files', true)}<span class="strong small">Files &amp; Knowledge</span></div></td><td class="small">${employee.collections.length ? `Read: ${employee.collections.length} collection(s)` : 'No collections'} · <a href="#/employees/${employee.id}/files">manage</a></td><td></td></tr>
      </tbody></table></div>
      ${app.settings.approveAllOutbound ? `<div class="card-body"><div class="callout">${icon('shield')}<div class="small">Workspace setting active: every outbound action requires approval regardless of these levels.</div></div></div>` : ''}
    </div>
    <div class="col gap-16">
      <div class="card card-pad form-grid"><div class="between"><h3>${icon('globe')} Browser</h3><label class="toggle"><input type="checkbox" id="br-on" ${employee.browser.enabled ? 'checked' : ''}><span></span></label></div>
        <p class="help">Through the extension, ${esc(employee.name)} works only in the tab you select. Navigation is limited to that tab's site plus these domains:</p>
        <textarea class="textarea" id="br-domains" rows="3" placeholder="linkedin.com&#10;salesforce.com">${esc(employee.browser.domains.join('\n'))}</textarea>
        <button class="btn btn-sm" id="br-save">Save browser settings</button></div>
      <div class="card card-pad col"><h3>${icon('shield-check')} Approval policy</h3>
        <p class="small muted"><strong class="lvl-allow">Allow</strong> runs immediately. <strong class="lvl-approval">Needs approval</strong> pauses the task: “${esc(employee.name)} wants to send this email” → Approve / Edit / Reject. <strong class="lvl-deny">No access</strong> blocks the tool and tells the AI engine why.</p>
        <p class="small muted">Scripts can also require approval for all their outbound actions (Scripts → Edit).</p></div>
    </div></div>`;
  const save = async (e, reason) => persist(app, employee, e, reason);
  host.querySelectorAll('[data-perm]').forEach((s) => s.onchange = async () => {
    const [sys, scope] = s.dataset.perm.split(':');
    const e = clone(employee);
    e.permissions[sys] = { ...(e.permissions[sys] || {}), [scope]: s.value };
    await save(e, `${SYSTEMS[sys].name} ${scope} → ${s.value}`);
  });
  host.querySelector('#add-sys').onchange = async (ev) => {
    const sys = ev.target.value;
    if (!sys) return;
    const e = clone(employee);
    e.permissions[sys] = Object.fromEntries(SYSTEMS[sys].scopes.map((sc) => [sc, sc === 'read' || sc === 'extract' ? 'allow' : 'approval']));
    if (sys === 'browser') e.browser.enabled = true;
    await save(e, `Granted ${SYSTEMS[sys].name} access`);
  };
  host.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
    const e = clone(employee);
    delete e.permissions[b.dataset.revoke];
    if (b.dataset.revoke === 'browser') e.browser.enabled = false;
    await save(e, `Revoked ${SYSTEMS[b.dataset.revoke].name} access`);
  });
  host.querySelector('#br-save').onclick = async () => {
    const e = clone(employee);
    e.browser.enabled = host.querySelector('#br-on').checked;
    e.browser.domains = host.querySelector('#br-domains').value.split(/[\s,]+/).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
    if (e.browser.enabled && !e.permissions.browser) e.permissions.browser = { read: 'allow', extract: 'allow', navigate: 'approval', click: 'approval', form_input: 'approval' };
    await save(e, `Browser ${e.browser.enabled ? 'enabled' : 'disabled'} (${e.browser.domains.join(', ') || 'working tab only'})`);
  };
}

// ------------------------------------------------------------ Activity
async function activity({ host, app, employee }) {
  const rows = (await app.db.byIndex('activity', 'employeeId', employee.id)).sort((a, b) => b.ts - a.ts).slice(0, 300);
  host.innerHTML = `<div class="card">${activityTable(rows, { [employee.id]: employee }, { showEmployee: false })}</div>`;
  bindActivityRows(host, rows, 5);
}

// ------------------------------------------------------------ Performance
async function performance({ host, app, employee }) {
  const s = await computeStats(app.db, { employeeId: employee.id });
  const days = s.daily.slice(-14);
  const max = Math.max(1, ...days.map((d) => d.completed + d.failed + d.other));
  host.innerHTML = `<div class="stats">
      ${[['Tasks', s.tasks.total], ['Completed', s.tasks.completed], ['Failed', s.tasks.failed], ['Awaiting approval', s.tasks.waiting], ['Success rate', s.successRate === null ? '—' : `${s.successRate}%`], ['Time saved (est.)', fmtHours(s.minutesSaved)], ['Tool calls', s.toolCalls], ['Tokens', `${Math.round((s.tokens.input + s.tokens.output) / 1000)}k`]].map(([l, v]) => `<div class="stat"><div class="stat-top">${l}</div><div class="stat-value">${esc(v)}</div></div>`).join('')}
    </div>
    <div class="grid-2 mt-16" style="align-items:start">
      <div class="card card-pad"><h3>Tasks per day</h3>${days.length ? `<div class="bars">${days.map((d) => `<div class="bar" title="${d.date}: ${d.completed} completed, ${d.failed} failed"><span class="b-oth" style="height:${(d.other / max) * 120}px"></span><span class="b-err" style="height:${(d.failed / max) * 120}px"></span><span class="b-ok" style="height:${(d.completed / max) * 120}px"></span></div>`).join('')}</div><div class="bar-labels">${days.map((d) => `<span>${d.date.slice(5)}</span>`).join('')}</div>` : '<p class="small muted mt-8">No tasks yet.</p>'}</div>
      <div class="card card-pad"><h3>Business metrics</h3><p class="help mb-8">Recorded by the employee with record_metric during real tasks.</p>${Object.keys(s.metrics).length ? Object.entries(s.metrics).map(([k, v]) => `<div class="between small" style="padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(employee.metrics.find((m) => m.key === k)?.label || k.replace(/_/g, ' '))}</span><strong>${v}</strong></div>`).join('') : '<p class="small muted">No metrics recorded yet.</p>'}</div>
    </div>
    <div class="card mt-16"><div class="card-head"><h3>Script performance</h3></div><div class="table-wrap"><table class="log-table"><thead><tr><th>Script</th><th>Runs</th><th>Success</th><th>Failed</th><th>Avg duration</th></tr></thead><tbody>
      ${s.scripts.map((x) => `<tr><td class="small strong">${esc(x.name)}</td><td>${x.runs}</td><td class="s-ok">${x.success}</td><td class="${x.failed ? 's-err' : ''}">${x.failed}</td><td class="small muted">${Math.round(x.totalMs / Math.max(1, x.runs) / 1000)}s</td></tr>`).join('') || '<tr><td colspan="5" class="small muted">No script runs yet.</td></tr>'}
    </tbody></table></div></div>`;
  void now;
}
