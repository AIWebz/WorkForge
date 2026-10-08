import { esc, icon, refreshIcons, emptyState, toast, confirmDialog } from '../ui.js';
import { setAllEmployees } from '../state.js';
import { employeeCard } from './dashboard.js';
import { normalizeEmployee } from '../../extension/core/employee.js';
import { uid } from '../../extension/core/util.js';

export default async function employees(ctx) {
  const { el, app } = ctx;
  let filter = 'all';
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [emps, tasks, connections] = await Promise.all([app.db.all('employees'), app.db.all('tasks'), app.getConnections()]);
    const latest = (id) => tasks.filter((t) => t.employeeId === id).sort((a, b) => {
      const live = (t) => (['running', 'waiting_approval', 'queued'].includes(t.status) ? 1 : 0);
      return live(b) - live(a) || b.createdAt - a.createdAt;
    })[0];
    const list = emps.filter((e) => filter === 'all' || e.status === filter).sort((a, b) => b.createdAt - a.createdAt);
    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Employees</h1><p>Every employee was generated for your business by the AI engine.</p></div>
        <div class="row">${emps.some((e) => e.status === 'active') ? `<button class="btn btn-danger" id="pause-all" title="Emergency stop">${icon('octagon-pause')} Pause all</button>` : emps.some((e) => e.status === 'paused') ? `<button class="btn" id="resume-all">${icon('play')} Resume all</button>` : ''}<label class="btn">${icon('upload')} Import<input type="file" accept="application/json" id="import" hidden></label></div></div>
      <div class="seg mb-16">${['all', 'active', 'draft', 'paused'].map((f) => `<button data-f="${f}" class="${filter === f ? 'active' : ''}">${f[0].toUpperCase() + f.slice(1)} (${f === 'all' ? emps.length : emps.filter((e) => e.status === f).length})</button>`).join('')}</div>
      ${list.length ? `<div class="grid-3">${list.map((e) => employeeCard(e, latest(e.id), connections)).join('')}</div>` : emptyState('users', emps.length ? 'No employees match this filter' : 'No employees yet', 'Describe the work you need and the AI engine will build a complete employee with scripts, tools, memory and permissions.', '<a class="btn btn-primary" href="#/create">Create Employee</a>')}
    </div>`;
    el.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filter = b.dataset.f; render(); });
    el.querySelector('#pause-all')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Pause every active employee? Running tasks stop after their current step; nothing new starts until you resume.', { confirm: 'Pause all', danger: true }))) return;
      const n = await setAllEmployees('paused');
      toast(`${n} employee${n === 1 ? '' : 's'} paused`, 'success');
    });
    el.querySelector('#resume-all')?.addEventListener('click', async () => { const n = await setAllEmployees('active'); toast(`${n} employee${n === 1 ? '' : 's'} resumed`, 'success'); });
    el.querySelector('#import').onchange = async (e) => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        if (!data.scripts) throw new Error('Not a WorkForge employee export');
        const emp = normalizeEmployee(data, { request: data.request || '' });
        Object.assign(emp, { permissions: data.permissions || emp.permissions, browser: { domains: [...(data.browser?.domains || emp.browser?.domains || [])] }, collections: [], status: 'draft', id: uid('emp') });
        await app.db.put('employees', emp);
        toast(`Imported ${emp.name} as a draft`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
    refreshIcons();
  };
  ctx.watch(['employees', 'tasks', 'connections'], render);
  await render();
  void esc;
}
