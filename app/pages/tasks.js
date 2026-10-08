import { esc, icon, avatar, statusBadge, timeAgo, fmtDateTime, refreshIcons, emptyState, confirmDialog, toast } from '../ui.js';
import { activityTable, bindActivityRows } from './activity.js';
import { formatDuration, safeStringify } from '../../extension/core/util.js';

export default async function tasks(ctx) {
  if (ctx.params.id) return taskDetail(ctx);
  const { el, app } = ctx;
  let filter = 'all';
  el.innerHTML = '<div class="page" id="tp"></div>';
  const page = el.querySelector('#tp');
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [all, employees, schedules] = await Promise.all([app.db.all('tasks'), app.db.all('employees'), app.db.all('schedules')]);
    const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
    const groups = { all: () => true, active: (t) => ['running', 'queued', 'waiting_approval', 'paused'].includes(t.status), completed: (t) => t.status === 'completed', failed: (t) => ['failed', 'needs_attention', 'cancelled'].includes(t.status) };
    const list = all.filter(groups[filter]).sort((a, b) => b.createdAt - a.createdAt);
    const upcoming = schedules.filter((s) => s.status === 'scheduled').sort((a, b) => a.runAt - b.runAt);
    page.innerHTML = `<div class="page-head"><div><h1>Tasks</h1><p>Every task is executed by the AI engine through the employee's scripts.</p></div></div>
      <div class="seg mb-16">${Object.keys(groups).map((g) => `<button data-g="${g}" class="${g === filter ? 'active' : ''}">${g[0].toUpperCase() + g.slice(1)} (${all.filter(groups[g]).length})</button>`).join('')}</div>
      <div class="grid-2" style="grid-template-columns: 1fr 320px; align-items:start">
        <div class="card">${list.length ? `<div class="table-wrap"><table class="log-table"><thead><tr><th>Task</th><th>Employee</th><th>Progress</th><th>Created</th><th>Status</th></tr></thead><tbody>
          ${list.slice(0, 300).map((t) => `<tr class="clickable" data-open="${t.id}"><td><div class="small strong">${esc(t.title)}</div><div class="tiny muted">${esc(t.trigger)}${t.origin === 'extension' ? ' · extension' : ''}${t.error ? ` · <span class="s-err">${esc(t.error.slice(0, 80))}</span>` : ''}</div></td>
            <td><div class="row gap-6">${empById[t.employeeId] ? avatar(empById[t.employeeId], 'avatar-sm') : ''}<span class="small">${esc(empById[t.employeeId]?.name || 'Deleted')}</span></div></td>
            <td class="small">${t.scriptRuns.length} script${t.scriptRuns.length === 1 ? '' : 's'}${t.current ? ` · <span class="s-run">${esc(empById[t.employeeId]?.scripts.find((s) => s.id === t.current.scriptId)?.name || '')}</span>` : ''}</td>
            <td class="small muted">${timeAgo(t.createdAt)}</td><td>${statusBadge(t.status)}</td></tr>`).join('')}
        </tbody></table></div>` : emptyState('list-checks', 'No tasks', 'Run an employee from its profile, schedule it, or start it in a browser tab with the extension.')}</div>
        <div class="card"><div class="card-head"><h3>${icon('calendar-clock')} Scheduled follow-ups</h3></div><div class="card-body">
          ${upcoming.length ? `<div class="feed">${upcoming.map((s) => `<div class="feed-item"><div class="grow"><div class="small strong">${esc(empById[s.employeeId]?.name || '')}</div><div class="small">${esc(s.instruction)}</div><div class="time">${fmtDateTime(s.runAt)} (${timeAgo(s.runAt)})</div></div><button class="btn btn-xs btn-ghost" data-cancel-sched="${s.id}" title="Cancel">${icon('x')}</button></div>`).join('')}</div>` : '<p class="small muted">Follow-ups scheduled by employees (schedule_followup) appear here. They run while WorkForce is open in a tab.</p>'}
        </div></div>
      </div>`;
    page.querySelectorAll('[data-g]').forEach((b) => b.onclick = () => { filter = b.dataset.g; render(); });
    page.querySelectorAll('[data-open]').forEach((r) => r.onclick = () => ctx.navigate(`/tasks/${r.dataset.open}`));
    page.querySelectorAll('[data-cancel-sched]').forEach((b) => b.onclick = async () => {
      const s = await app.db.get('schedules', b.dataset.cancelSched);
      await app.db.put('schedules', { ...s, status: 'cancelled' });
    });
    refreshIcons();
  };
  ctx.watch(['tasks', 'schedules'], render, 600);
  await render();
}

async function taskDetail(ctx) {
  const { el, app, params, navigate } = ctx;
  el.innerHTML = '<div class="page" id="td"></div>';
  const page = el.querySelector('#td');
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const task = await app.db.get('tasks', params.id);
    if (!task) { page.innerHTML = emptyState('list-checks', 'Task not found', 'It may have been deleted.'); return; }
    const employee = await app.db.get('employees', task.employeeId);
    const act = (await app.db.byIndex('activity', 'taskId', task.id)).sort((a, b) => a.ts - b.ts);
    const current = task.current && employee ? employee.scripts.find((s) => s.id === task.current.scriptId) : null;
    const live = ['running', 'queued', 'waiting_approval', 'paused'].includes(task.status);
    page.innerHTML = `<a class="back" href="#/tasks">${icon('arrow-left')} Back to tasks</a>
      <div class="page-head"><div><div class="row">${statusBadge(task.status)}<span class="small muted">${esc(task.trigger)} · ${fmtDateTime(task.createdAt)}${task.completedAt ? ` · took ${formatDuration(task.completedAt - (task.startedAt || task.createdAt))}` : ''}</span></div><h1 class="mt-8">${esc(task.title)}</h1>
        ${employee ? `<a class="row small mt-8" href="#/employees/${employee.id}">${avatar(employee, 'avatar-sm')}${esc(employee.name)} — ${esc(employee.role)}</a>` : ''}</div>
        <div class="row">${live && task.origin !== 'extension' ? `<button class="btn btn-danger" id="cancel">${icon('square')} Cancel</button>` : ''}${!live && employee && task.origin !== 'extension' ? `<button class="btn" id="rerun">${icon('rotate-ccw')} Run again</button>` : ''}</div></div>
      ${task.error ? `<div class="callout danger mb-16">${icon('alert-triangle')}<div class="small">${esc(task.error)}</div></div>` : ''}
      <div class="grid-2" style="grid-template-columns: 1fr 1.3fr; align-items:start">
        <div class="col gap-16">
          <div class="card card-pad"><h3>Input</h3><pre class="light mt-8">${esc(task.input || '(none)')}</pre>${task.browser ? `<p class="small muted mt-8">${icon('globe')} Browser tab: ${esc(task.browser.title || '')} ${esc(task.browser.url || '')}</p>` : ''}</div>
          <div class="card"><div class="card-head"><h3>Script execution</h3><span class="small muted">${task.steps} step${task.steps === 1 ? '' : 's'}</span></div><div class="card-body col">
            ${task.scriptRuns.map((r, i) => `<div class="script-card"><div class="between"><div class="row"><span class="num">${i + 1}</span><strong class="small">${esc(r.name)}</strong></div>${statusBadge(r.status === 'success' ? 'success' : r.status === 'failed' ? 'failed' : 'needs_attention', r.status)}</div>
              <div class="small">${esc(r.summary)}</div>${r.reason ? `<div class="tiny muted">Next-step reason: ${esc(r.reason)}</div>` : ''}
              <details><summary class="tiny muted" style="cursor:pointer">Output · ${r.toolCalls} tool calls · ${formatDuration((r.endedAt || 0) - (r.startedAt || 0))}</summary><pre class="light mt-8">${esc(safeStringify(r.output, 2))}</pre></details></div>`).join('')}
            ${current ? `<div class="script-card" style="border-color:#c7d2fe"><div class="row"><span class="spinner sm"></span><strong class="small">${esc(current.name)}</strong>${task.status === 'waiting_approval' ? '<a class="badge badge-warning" href="#/approvals">waiting for approval</a>' : ''}</div></div>` : ''}
            ${!task.scriptRuns.length && !current ? '<p class="small muted">No scripts executed yet.</p>' : ''}
          </div></div>
          <div class="card card-pad"><h3>Result</h3><p class="small mt-8">${esc(task.result || (live ? 'In progress…' : '—'))}</p>
            <div class="row wrap small muted mt-12">${Object.entries(task.metrics || {}).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join('')}<span>Tokens: ${task.usage.input.toLocaleString()} in / ${task.usage.output.toLocaleString()} out</span></div></div>
        </div>
        <div class="card"><div class="card-head"><h3>Execution log</h3><span class="small muted">${act.length} events</span></div><div id="log">${activityTable(act, employee ? { [employee.id]: employee } : {}, { showEmployee: false })}</div></div>
      </div>`;
    bindActivityRows(page, act, 5);
    page.querySelector('#cancel')?.addEventListener('click', async () => {
      if (await confirmDialog('Cancel this task? Pending approvals for it are cancelled too.', { confirm: 'Cancel task', danger: true })) { await app.runtime.cancelTask(task.id); toast('Task cancelled'); }
    });
    page.querySelector('#rerun')?.addEventListener('click', async () => {
      const t = await app.runtime.createTask(employee, { input: task.input, title: task.title, trigger: 'manual (re-run)', entryScript: task.entryScript });
      navigate(`/tasks/${t.id}`);
    });
    refreshIcons();
  };
  ctx.watch(['tasks', 'activity'], render, 500);
  await render();
}
