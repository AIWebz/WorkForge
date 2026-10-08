import { esc, icon, avatar, statusBadge, timeAgo, fmtHours, refreshIcons, emptyState, statusColor } from '../ui.js';
import { computeStats } from '../../extension/core/reports.js';
import { SYSTEMS } from '../../extension/core/catalog.js';
import { employeeSystemIds, systemLogos } from './workflow.js';
import { bridge } from '../bridge.js';

export default async function dashboard(ctx) {
  const { el, app } = ctx;
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [employees, tasks, approvals, connections, activityAll, stats, aiReady] = await Promise.all([
      app.db.all('employees'), app.db.all('tasks'), app.db.byIndex('approvals', 'status', 'pending'), app.getConnections(), app.db.all('activity'), computeStats(app.db), app.aiReady(),
    ]);
    const activity = activityAll.sort((a, b) => b.ts - a.ts).slice(0, 14);
    const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
    const live = (id) => tasks.filter((t) => t.employeeId === id && ['running', 'waiting_approval', 'queued'].includes(t.status)).sort((a, b) => b.createdAt - a.createdAt)[0];
    const lastTask = (id) => tasks.filter((t) => t.employeeId === id).sort((a, b) => b.createdAt - a.createdAt)[0];
    // A system is connected when its row exists in the connections store.
    const connected = connections.length;
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const working = employees.filter((e) => live(e.id)).length;

    const setup = [
      [!!app.business, 'Describe your business', '#/settings/business'],
      [aiReady, 'Connect the AI engine', '#/settings/ai'],
      [employees.length > 0, 'Generate your first employee', '#/create'],
      [connected > 0, 'Connect your systems', '#/systems'],
      [bridge.paired, 'Install the browser extension', '#/extension'],
    ];
    const setupDone = setup.filter((s) => s[0]).length;

    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${greet}. Here's what your workforce is doing.</h1><p>${working ? `${working} employee${working > 1 ? 's' : ''} working right now` : employees.length ? 'All employees are idle' : 'You have no employees yet'} · ${approvals.length} approval${approvals.length === 1 ? '' : 's'} waiting</p></div>
      <a class="btn btn-primary" href="#/create">${icon('sparkles')} Create Employee</a></div>
      ${setupDone < setup.length ? `<div class="card card-pad mb-16"><div class="between"><h3>Get set up</h3><span class="small muted">${setupDone}/${setup.length} complete</span></div><div class="meter mt-8"><span style="width:${(setupDone / setup.length) * 100}%"></span></div>
        <div class="row wrap mt-12 gap-6">${setup.map(([ok, label, href]) => `<a class="chip" href="${href}" style="${ok ? 'color:var(--success)' : ''}">${icon(ok ? 'check-circle-2' : 'circle')}${label}</a>`).join('')}</div></div>` : ''}
      <div class="stats">
        ${stat('users', 'Active Employees', employees.filter((e) => e.status === 'active').length, `${employees.length} total`)}
        ${stat('check-circle-2', 'Tasks Completed', stats.tasks.completed, `${stats.tasks.failed} failed`)}
        ${stat('loader', 'Tasks Running', stats.tasks.running, `${stats.tasks.waiting} awaiting approval`)}
        ${stat('shield-check', 'Human Approvals', approvals.length, 'pending', approvals.length ? '#/approvals' : '')}
        ${stat('target', 'Success Rate', stats.successRate === null ? '—' : `${stats.successRate}%`, 'of finished tasks')}
        ${stat('clock', 'Hours Saved', fmtHours(stats.minutesSaved), 'estimated from script runs')}
        ${stat('plug', 'Connected Systems', connected, `${Object.keys(SYSTEMS).length} web apps + your own`, '#/systems')}
      </div>
      <div class="grid-2 mt-24" style="grid-template-columns: 1fr 340px; align-items:start">
        <div class="card">
          <div class="card-head"><div><h3><span class="status-dot" style="background:var(--success)"></span> Live Workforce</h3><div class="tiny muted">${working} employee${working === 1 ? '' : 's'} active right now</div></div><a class="small" href="#/employees">View all</a></div>
          <div class="card-body">${employees.length ? `<div class="grid-3">${employees.map((e) => employeeCard(e, live(e.id) || lastTask(e.id), connections)).join('')}</div>` : emptyState('users', 'No employees yet', 'Describe the work you need done and WorkForge will generate a complete AI employee.', '<a class="btn btn-primary" href="#/create">Create Employee</a>')}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Recent Activity</h3><a class="small" href="#/activity">View all</a></div>
          <div class="card-body" style="padding-top:4px">${activity.length ? `<div class="feed">${activity.map((a) => `<div class="feed-item">${empById[a.employeeId] ? avatar(empById[a.employeeId], 'avatar-sm') : `<span class="avatar avatar-sm" style="background:#cbd5e1">${icon('cpu')}</span>`}<div class="grow"><div><span class="status-dot" style="background:${statusColor(a.status)};margin-right:6px"></span>${esc(a.message)}</div><div class="time">${timeAgo(a.ts)}${a.scriptName ? ` · ${esc(a.scriptName)}` : ''}</div></div></div>`).join('')}</div>` : '<p class="small muted" style="padding:12px 0">Activity from real executions appears here.</p>'}
            <div class="row small mt-12"><span class="status-dot" style="background:${aiReady ? 'var(--success)' : 'var(--warning)'}"></span>${aiReady ? 'AI engine ready' : 'AI engine not configured'}</div>
          </div>
        </div>
      </div>
    </div>`;
    refreshIcons();
  };
  ctx.watch(['employees', 'tasks', 'activity', 'approvals', 'connections'], render, 500);
  await render();
}

function stat(ic, label, value, sub, href = '') {
  const inner = `<div class="stat-top"><span class="stat-icon">${icon(ic)}</span>${label}</div><div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub)}</div>`;
  return href ? `<a class="stat" href="${href}" style="color:inherit;text-decoration:none">${inner}</a>` : `<div class="stat">${inner}</div>`;
}

export function employeeCard(e, task, connections = []) {
  const isLive = task && ['running', 'waiting_approval', 'queued'].includes(task.status);
  const status = e.status === 'paused' ? 'paused' : isLive ? (task.status === 'waiting_approval' ? 'waiting_approval' : 'working') : e.status;
  const runs = task?.scriptRuns || [];
  const steps = runs.slice(-3).map((r) => `<div class="s"><span class="${r.status === 'success' ? 's-ok' : 's-err'}">${icon(r.status === 'success' ? 'check' : 'x')}</span><span class="ellipsis">${esc(r.name)}</span></div>`);
  if (isLive && task.current) {
    const sc = e.scripts.find((s) => s.id === task.current.scriptId);
    steps.push(`<div class="s s-${task.status === 'waiting_approval' ? 'wait' : 'run'}">${icon(task.status === 'waiting_approval' ? 'pause-circle' : 'arrow-right')}<span class="ellipsis">${esc(sc?.name || task.current.scriptId)}</span></div>`);
  }
  return `<a class="emp-card" href="#/employees/${e.id}">
    <div class="emp-head">${avatar(e)}<div class="grow"><div class="emp-name">${esc(e.name)}</div><div class="emp-role ellipsis">${esc(e.role)}</div></div>${statusBadge(status)}</div>
    <div class="emp-task"><div class="tiny muted">${isLive ? 'Current task' : task ? `Last task · ${timeAgo(task.createdAt)}` : 'No tasks yet'}</div><div class="small strong ellipsis mt-4">${esc(task?.title || e.summary || '')}</div>
    ${steps.length ? `<div class="steps-mini mt-8">${steps.join('')}</div>` : ''}</div>
    <div class="between">${systemLogos(employeeSystemIds(e, connections), connections, 5) || '<span class="tiny muted">No systems</span>'}<span class="tiny muted">${e.scripts.length} scripts</span></div>
  </a>`;
}
