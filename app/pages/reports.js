import { esc, icon, fmtHours, refreshIcons, toast, md, fmtDateTime, emptyState, download, avatar } from '../ui.js';
import { computeStats, summarizeStats } from '../../extension/core/reports.js';
import { uid } from '../../extension/core/util.js';

const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']];

export default async function reports(ctx) {
  const { el, app } = ctx;
  let period = '7';
  el.innerHTML = '<div class="page" id="rp"></div>';
  const page = el.querySelector('#rp');
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const since = period === 'all' ? 0 : Date.now() - Number(period) * 86400000;
    const [s, saved, employees] = await Promise.all([computeStats(app.db, { since }), app.db.all('reports'), app.db.all('employees')]);
    const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
    const days = s.daily.slice(-30);
    const max = Math.max(1, ...days.map((d) => d.completed + d.failed + d.other));
    const metricLabel = (k) => employees.flatMap((e) => e.metrics || []).find((m) => m.key === k)?.label || k.replace(/_/g, ' ');
    page.innerHTML = `<div class="page-head"><div><h1>Reports</h1><p>Computed from real task, script and approval records. The AI engine writes summaries from this data only.</p></div>
      <div class="row"><div class="seg">${PERIODS.map(([v, l]) => `<button data-p="${v}" class="${period === v ? 'active' : ''}">${l}</button>`).join('')}</div><button class="btn btn-primary" id="gen">${icon('sparkles')} Generate AI summary</button></div></div>
      <div class="stats">
        ${[['check-circle-2', 'Tasks completed', s.tasks.completed], ['x-circle', 'Tasks failed', s.tasks.failed + s.tasks.needsAttention], ['shield-check', 'Awaiting approval', s.tasks.waiting], ['target', 'Success rate', s.successRate === null ? '—' : `${s.successRate}%`], ['clock', 'Time saved (est.)', fmtHours(s.minutesSaved)], ['workflow', 'Script runs', s.scriptRuns], ['wrench', 'Tool calls', `${s.toolCalls}${s.toolErrors ? ` (${s.toolErrors} errors)` : ''}`], ['check', 'Approvals', `${s.approvals.approved} ✓ / ${s.approvals.rejected} ✕`]]
    .map(([ic, l, v]) => `<div class="stat"><div class="stat-top"><span class="stat-icon">${icon(ic)}</span>${l}</div><div class="stat-value">${esc(v)}</div></div>`).join('')}
      </div>
      <div class="grid-2 mt-16" style="align-items:start">
        <div class="card card-pad"><div class="between"><h3>Tasks per day</h3><span class="tiny muted"><span class="status-dot" style="background:#6366f1"></span> completed <span class="status-dot" style="background:#fca5a5;margin-left:8px"></span> failed</span></div>
          ${days.length ? `<div class="bars">${days.map((d) => `<div class="bar" title="${d.date}: ${d.completed} completed, ${d.failed} failed, ${d.other} other"><span class="b-oth" style="height:${(d.other / max) * 120}px"></span><span class="b-err" style="height:${(d.failed / max) * 120}px"></span><span class="b-ok" style="height:${(d.completed / max) * 120}px"></span></div>`).join('')}</div><div class="bar-labels">${days.map((d) => `<span>${d.date.slice(5)}</span>`).join('')}</div>` : '<p class="small muted mt-8">No tasks in this period.</p>'}</div>
        <div class="card card-pad"><h3>Business outcomes</h3><p class="help mb-8">Metrics employees recorded during real work (leads processed, meetings booked, requests handled…).</p>
          ${Object.keys(s.metrics).length ? Object.entries(s.metrics).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="between small" style="padding:7px 0;border-bottom:1px solid var(--border)"><span style="text-transform:capitalize">${esc(metricLabel(k))}</span><strong>${v.toLocaleString()}</strong></div>`).join('') : '<p class="small muted">No metrics recorded yet.</p>'}</div>
      </div>
      <div class="card mt-16"><div class="card-head"><h3>Employee performance</h3></div><div class="table-wrap"><table class="log-table"><thead><tr><th>Employee</th><th>Tasks</th><th>Completed</th><th>Failed</th><th>Success rate</th><th>Script runs</th><th>Time saved</th></tr></thead><tbody>
        ${s.perEmployee.map((e) => `<tr><td><a class="row gap-6" href="#/employees/${e.id}">${empById[e.id] ? avatar(empById[e.id], 'avatar-sm') : ''}<span class="small strong">${esc(e.name)}</span><span class="tiny muted">${esc(e.role)}</span></a></td><td>${e.tasks}</td><td>${e.completed}</td><td>${e.failed}</td><td>${e.successRate === null ? '—' : `${e.successRate}%`}</td><td>${e.scriptRuns}</td><td>${fmtHours(e.minutesSaved)}</td></tr>`).join('') || '<tr><td colspan="7" class="small muted">No employees</td></tr>'}
      </tbody></table></div></div>
      <h2 class="mt-24 mb-16">AI summaries</h2>
      ${saved.length ? `<div class="col gap-16">${saved.sort((a, b) => b.createdAt - a.createdAt).map((r) => `<div class="card card-pad"><div class="between mb-8"><div><h3>${esc(r.title)}</h3><div class="tiny muted">${fmtDateTime(r.createdAt)} · ${esc(r.model || '')}</div></div><div class="row"><button class="btn btn-xs" data-dl="${r.id}">${icon('download')}</button><button class="btn btn-xs btn-ghost" data-del="${r.id}">${icon('trash-2')}</button></div></div>${md(r.text)}</div>`).join('')}</div>`
    : `<div class="card">${emptyState('file-bar-chart', 'No summaries yet', 'Generate a natural-language summary of real employee activity for this period.')}</div>`}`;
    page.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { period = b.dataset.p; render(); });
    page.querySelector('#gen').onclick = async (e) => {
      const btn = e.currentTarget;
      if (!(await app.aiReady())) return toast('Configure the AI engine first', 'error');
      if (!s.tasks.total) return toast('There is no task data in this period to summarize yet.', 'error');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm"></span> Writing…';
      try {
        const ai = await app.getAI();
        const tasks = (await app.db.all('tasks')).filter((t) => t.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt).map((t) => ({ ...t, employeeName: empById[t.employeeId]?.name }));
        const title = `${PERIODS.find((p) => p[0] === period)[1]} — Workforce report`;
        const text = await summarizeStats(ai, { ...s, perEmployee: s.perEmployee, daily: s.daily.slice(-30) }, { title, recentTasks: tasks });
        await app.db.put('reports', { id: uid('rep'), title, text, period, stats: s, model: ai.model, createdAt: Date.now() });
        toast('Report generated', 'success');
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.innerHTML = `${icon('sparkles')} Generate AI summary`; refreshIcons(); }
    };
    page.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => app.db.delete('reports', b.dataset.del));
    page.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => { const r = saved.find((x) => x.id === b.dataset.dl); download(`${r.title.replace(/\W+/g, '-')}.md`, `# ${r.title}\n\n${r.text}\n`, 'text/markdown'); });
    refreshIcons();
  };
  ctx.watch(['tasks', 'reports', 'approvals'], render, 800);
  await render();
}
