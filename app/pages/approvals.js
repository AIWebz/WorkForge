import { esc, icon, avatar, statusBadge, timeAgo, fmtDateTime, refreshIcons, emptyState, toast } from '../ui.js';
import { TOOL_MAP, SYSTEMS } from '../../extension/core/catalog.js';
import { safeStringify } from '../../extension/core/util.js';

export default async function approvals(ctx) {
  const { el, app } = ctx;
  el.innerHTML = '<div class="page" id="ap"></div>';
  const page = el.querySelector('#ap');
  const editing = new Set();
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [all, employees] = await Promise.all([app.db.all('approvals'), app.db.all('employees')]);
    const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
    const pending = all.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const history = all.filter((a) => a.status !== 'pending').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0)).slice(0, 100);
    page.innerHTML = `<div class="page-head"><div><h1>Human Approval Center</h1><p>Actions your employees want to take that require a person. Approve, edit, reject, or pause the employee.</p></div></div>
      ${pending.length ? `<div class="col gap-16">${pending.map((a) => card(a, empById[a.employeeId], editing.has(a.id))).join('')}</div>` : `<div class="card">${emptyState('shield-check', 'Nothing waiting for you', 'When an employee wants to send an email, update a record, book a meeting or click in your browser, it appears here first.')}</div>`}
      <h2 class="mt-24 mb-16">History</h2>
      <div class="card">${history.length ? `<div class="table-wrap"><table class="log-table"><thead><tr><th>Request</th><th>Employee</th><th>Requested</th><th>Resolved</th><th>Outcome</th></tr></thead><tbody>${history.map((a) => `<tr><td><div class="small">${esc(a.summary)}</div>${a.note ? `<div class="tiny muted">Note: ${esc(a.note)}</div>` : ''}${a.response ? `<div class="tiny muted">Response: ${esc(a.response)}</div>` : ''}</td><td class="small">${esc(a.employeeName || empById[a.employeeId]?.name || '')}</td><td class="small muted">${fmtDateTime(a.createdAt)}</td><td class="small muted">${fmtDateTime(a.resolvedAt)}</td><td>${statusBadge(a.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted card-body">No resolved approvals yet.</p>'}</div>`;
    bind(pending);
    refreshIcons();
  };

  function card(a, emp, isEditing) {
    const tool = TOOL_MAP[a.tool];
    const ext = a.origin === 'extension';
    const args = a.args || {};
    return `<div class="approval pending" data-ap="${a.id}">
      <div class="between"><div class="row">${emp ? avatar(emp) : ''}<div><div class="strong">${esc(a.summary)}</div><div class="tiny muted">${esc(a.taskTitle || '')} · ${esc(a.scriptName || '')} · ${timeAgo(a.createdAt)}</div></div></div>
      <div class="row">${a.kind === 'escalation' ? '<span class="badge badge-danger">Escalation</span>' : `<span class="badge">${esc(SYSTEMS[tool?.system]?.name || tool?.system || '')} · ${esc(a.tool)}</span>`}${ext ? `<span class="badge badge-info">${icon('puzzle')} Extension</span>` : ''}</div></div>
      ${a.reason ? `<div class="small muted">Why approval is required: ${esc(a.reason)}</div>` : ''}
      ${a.kind === 'escalation' ? `<div class="callout">${icon('help-circle')}<div><div class="strong small">${esc(args.question || '')}</div>${args.context ? `<div class="small mt-4">${esc(args.context)}</div>` : ''}</div></div>
        <textarea class="textarea" data-response rows="3" placeholder="Your answer / decision for ${esc(emp?.name || 'the employee')}…" ${ext ? 'disabled' : ''}></textarea>`
    : isEditing ? `<div class="form-grid">${Object.entries(args).map(([k, v]) => `<label class="field"><span>${esc(k)}</span>${typeof v === 'string' && v.length > 80 ? `<textarea class="textarea" data-arg="${esc(k)}" data-type="string" rows="6">${esc(v)}</textarea>` : `<input class="input" data-arg="${esc(k)}" data-type="${typeof v === 'string' ? 'string' : 'json'}" value="${esc(typeof v === 'string' ? v : JSON.stringify(v))}">`}</label>`).join('')}</div>`
      : `<div class="kv">${Object.entries(args).map(([k, v]) => `<dt>${esc(k)}</dt><dd style="white-space:pre-wrap">${esc(typeof v === 'string' ? v : safeStringify(v, 1))}</dd>`).join('')}</div>`}
      ${ext ? `<div class="callout">${icon('info')}<div class="small">This task is running in the WorkForce browser extension. Resolve it in the extension side panel.</div></div>` : `<div class="row wrap">
        ${a.kind === 'escalation' ? `<button class="btn btn-success btn-sm" data-do="respond">${icon('send')} Send response</button><button class="btn btn-sm btn-danger" data-do="reject">${icon('x')} Decline</button>`
    : isEditing ? `<button class="btn btn-success btn-sm" data-do="edit">${icon('check')} Approve edited</button><button class="btn btn-sm" data-do="cancel-edit">Cancel edit</button>`
      : `<button class="btn btn-success btn-sm" data-do="approve">${icon('check')} Approve</button><button class="btn btn-sm" data-do="start-edit">${icon('pencil')} Edit</button><button class="btn btn-sm btn-danger" data-do="reject">${icon('x')} Reject</button>`}
        <input class="input" data-note placeholder="Note to the employee (optional)" style="max-width:280px;height:30px;padding:4px 10px;font-size:12.5px">
        <div class="grow"></div>
        ${emp?.status !== 'paused' ? `<button class="btn btn-sm btn-ghost" data-do="pause">${icon('pause')} Pause ${esc(emp?.name || 'employee')}</button>` : '<span class="badge badge-warning">Employee paused</span>'}
        <a class="btn btn-sm btn-ghost" href="#/tasks/${a.taskId}">${icon('external-link')} Task</a>
      </div>`}
    </div>`;
  }

  function bind(pending) {
    page.querySelectorAll('[data-ap]').forEach((node) => {
      const a = pending.find((x) => x.id === node.dataset.ap);
      node.querySelectorAll('[data-do]').forEach((b) => b.onclick = async () => {
        const note = node.querySelector('[data-note]')?.value.trim() || '';
        b.disabled = true;
        try {
          switch (b.dataset.do) {
            case 'approve': await app.runtime.resolveApproval(a.id, 'approve', { note }); toast('Approved — the employee continues', 'success'); break;
            case 'reject': await app.runtime.resolveApproval(a.id, 'reject', { note }); toast('Rejected'); break;
            case 'respond': await app.runtime.resolveApproval(a.id, 'approve', { response: node.querySelector('[data-response]').value.trim(), note }); toast('Response sent', 'success'); break;
            case 'start-edit': editing.add(a.id); render(); return;
            case 'cancel-edit': editing.delete(a.id); render(); return;
            case 'edit': {
              const args = { ...a.args };
              for (const inp of node.querySelectorAll('[data-arg]')) {
                const k = inp.dataset.arg;
                if (inp.dataset.type === 'json') { try { args[k] = JSON.parse(inp.value); } catch { throw new Error(`“${k}” must be valid JSON`); } } else args[k] = inp.value;
              }
              editing.delete(a.id);
              await app.runtime.resolveApproval(a.id, 'edit', { args, note });
              toast('Edited and approved', 'success');
              break;
            }
            case 'pause': await app.runtime.setEmployeeStatus(a.employeeId, 'paused'); toast('Employee paused — its running tasks stop after the current step'); break;
          }
        } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      });
    });
  }

  ctx.watch(['approvals', 'employees'], render, 300);
  await render();
}
