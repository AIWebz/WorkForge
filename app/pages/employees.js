import { esc, icon, refreshIcons, emptyState, toast } from '../ui.js';
import { employeeCard } from './dashboard.js';
import { normalizeEmployee } from '../../extension/core/employee.js';
import { uid } from '../../extension/core/util.js';

export default async function employees(ctx) {
  const { el, app } = ctx;
  let filter = 'all';
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [emps, tasks] = await Promise.all([app.db.all('employees'), app.db.all('tasks')]);
    const latest = (id) => tasks.filter((t) => t.employeeId === id).sort((a, b) => {
      const live = (t) => (['running', 'waiting_approval', 'queued'].includes(t.status) ? 1 : 0);
      return live(b) - live(a) || b.createdAt - a.createdAt;
    })[0];
    const list = emps.filter((e) => filter === 'all' || e.status === filter).sort((a, b) => b.createdAt - a.createdAt);
    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Employees</h1><p>Every employee was generated for your business by the AI engine.</p></div>
        <div class="row"><label class="btn">${icon('upload')} Import<input type="file" accept="application/json" id="import" hidden></label><a class="btn btn-primary" href="#/create">${icon('plus')} Create Employee</a></div></div>
      <div class="seg mb-16">${['all', 'active', 'draft', 'paused'].map((f) => `<button data-f="${f}" class="${filter === f ? 'active' : ''}">${f[0].toUpperCase() + f.slice(1)} (${f === 'all' ? emps.length : emps.filter((e) => e.status === f).length})</button>`).join('')}</div>
      ${list.length ? `<div class="grid-3">${list.map((e) => employeeCard(e, latest(e.id))).join('')}</div>` : emptyState('users', emps.length ? 'No employees match this filter' : 'No employees yet', 'Describe the work you need and the AI engine will build a complete employee with scripts, tools, memory and permissions.', '<a class="btn btn-primary" href="#/create">Create Employee</a>')}
    </div>`;
    el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filter = b.dataset.f; render(); });
    el.querySelector('#import').onchange = async (e) => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        if (!data.scripts) throw new Error('Not a WorkForce employee export');
        const emp = normalizeEmployee(data, { request: data.request || '' });
        Object.assign(emp, { permissions: data.permissions || emp.permissions, browser: data.browser || emp.browser, collections: [], status: 'draft', id: uid('emp') });
        await app.db.put('employees', emp);
        toast(`Imported ${emp.name} as a draft`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
    refreshIcons();
  };
  ctx.watch(['employees', 'tasks'], render);
  await render();
  void esc;
}
