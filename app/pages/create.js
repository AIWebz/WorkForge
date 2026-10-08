import { esc, icon, on, toast, avatar, sysIcon, refreshIcons, statusBadge } from '../ui.js';
import { CONNECTIONS, SYSTEMS } from '../../extension/core/catalog.js';
import { generateEmployee, GENERATION_STAGES } from '../../extension/core/generator.js';
import { scheduleNext } from '../../extension/core/employee.js';
import { uid } from '../../extension/core/util.js';
import { renderWorkflow } from './workflow.js';

const PERMS = [
  { key: 'files', label: 'Read knowledge files', apply: (p) => { p.files = { read: 'allow' }; }, deny: () => {} },
  { key: 'crm_read', label: 'Access CRM data', apply: (p) => { for (const s of ['hubspot', 'salesforce']) p[s] = { ...(p[s] || {}), read: 'allow' }; }, deny: (p) => { for (const s of ['hubspot', 'salesforce']) p[s] = { ...(p[s] || {}), read: 'deny' }; }, text: 'access CRM data' },
  { key: 'crm_write', label: 'Update CRM records', apply: (p) => { for (const s of ['hubspot', 'salesforce']) p[s] = { ...(p[s] || {}), write: 'approval' }; }, deny: (p) => { for (const s of ['hubspot', 'salesforce']) p[s] = { ...(p[s] || {}), write: 'deny' }; }, text: 'update CRM records' },
  { key: 'email', label: 'Send emails', apply: (p) => { p.gmail = { ...(p.gmail || {}), send: 'approval' }; }, deny: (p) => { p.gmail = { ...(p.gmail || {}), send: 'deny' }; }, text: 'send emails' },
  { key: 'calendar', label: 'Make calendar bookings', apply: (p) => { p.google_calendar = { ...(p.google_calendar || {}), create: 'approval' }; }, deny: (p) => { p.google_calendar = { ...(p.google_calendar || {}), create: 'deny' }; }, text: 'book calendar events' },
  { key: 'slack', label: 'Post to Slack', apply: (p) => { p.slack = { ...(p.slack || {}), send: 'approval' }; }, deny: (p) => { p.slack = { ...(p.slack || {}), send: 'deny' }; }, text: 'post to Slack' },
];
const DEFAULT_PERMS = new Set(['files', 'crm_read', 'crm_write', 'email', 'calendar', 'slack']);

const INTEGRATIONS = [
  ...Object.entries(CONNECTIONS).map(([id, c]) => ({ id, name: c.name, sub: c.systems.map((s) => SYSTEMS[s].name).join(', '), systems: c.systems })),
  { id: 'web', name: 'Web Research', sub: 'Public websites', systems: ['web'] },
];

// ------------------------------------------------------------ generation jobs
export function startGeneration(app, { request, form = {} }) {
  const id = uid('job');
  const job = { id, request, form, stages: Object.fromEntries(GENERATION_STAGES.map((s) => [s.id, { status: 'pending', detail: '' }])), status: 'running', error: '', employeeId: null, startedAt: Date.now() };
  app.jobs[id] = job;
  const emit = () => app.events.emit({ type: 'job', id });
  (async () => {
    try {
      const ai = await app.getAI();
      const [connections, collections] = await Promise.all([app.connectionMap(), app.db.all('collections')]);
      const employee = await generateEmployee({
        db: app.db, ai, request, business: app.business, form, connections, collections,
        onStage: (stage, status, detail) => { job.stages[stage] = { status, detail: detail || '' }; emit(); },
      });
      job.employeeId = employee.id;
      job.status = 'done';
      await app.db.put('activity', { id: uid('act'), ts: Date.now(), employeeId: employee.id, taskId: null, origin: 'app', type: 'employee_created', status: 'success', message: `${employee.name} — ${employee.role} generated with ${employee.scripts.length} scripts` });
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
    }
    emit();
  })();
  return id;
}

export default async function create(ctx) {
  if (ctx.params.job) return generationScreen(ctx);
  return createForm(ctx);
}

async function createForm({ el, app, navigate, query }) {
  const [connections, collections, aiReady] = await Promise.all([app.connectionMap(), app.db.all('collections'), app.aiReady()]);
  const selected = new Set(Object.values(connections).filter((c) => c.status === 'connected').map((c) => c.id));
  let expert = false;
  const prefill = query.request || app.business?.automate || '';

  el.innerHTML = `<div class="page">
    <a class="back" href="#/employees">${icon('arrow-left')} Back to employees</a>
    <div class="page-head">
      <div><h1>Create Your AI Employee</h1><p>Describe what you need and the AI engine will generate a fully configured employee with scripts, tools, memory, workflows and permissions.</p></div>
      <div class="row small" style="border:1px solid var(--border);border-radius:999px;padding:6px 12px;background:#fff">${icon('settings-2')} Expert mode <label class="toggle"><input type="checkbox" id="expert"><span></span></label></div>
    </div>
    ${aiReady ? '' : `<div class="callout warn mb-16">${icon('alert-triangle')}<div>The AI engine is not configured${app.vault.locked ? ' (vault locked)' : ''}. <a href="#/settings/ai">Add your AI provider key</a> to generate employees.</div></div>`}
    <div class="grid-2" style="grid-template-columns: 1.15fr 1fr; align-items:start">
      <div class="card card-pad form-grid">
        <div class="form-row">
          <label class="field"><span>Employee Name</span><div class="input-icon">${icon('user')}<input class="input" id="f-name" placeholder="e.g. Alex (optional)"></div></label>
          <label class="field"><span>Role / Job Title</span><input class="input" id="f-role" placeholder="e.g. Lead Operations (optional)"></label>
        </div>
        <label class="field"><span>What employee do you need?</span>
          <textarea class="textarea" id="f-request" rows="7" maxlength="4000" placeholder="I need someone to handle incoming customer support requests, search our documentation, answer customers, escalate complex problems to humans, and create support tickets.">${esc(prefill)}</textarea>
          <div class="between"><span class="help">Describe the work, the systems involved, decisions it should make and what needs your approval.</span><span class="help" id="f-count">0/4000</span></div>
        </label>
        <div>
          <div class="row mb-8">${icon('lock')}<span class="label">Access &amp; Permissions</span></div>
          <p class="help mb-8">What can this employee access? Outbound actions always start as approval-required.</p>
          <div class="grid-2" style="gap:8px">${PERMS.map((p) => `<label class="check"><input type="checkbox" data-perm="${p.key}" ${DEFAULT_PERMS.has(p.key) ? 'checked' : ''}>${p.label}</label>`).join('')}</div>
        </div>
        <div id="expert-box" hidden class="form-grid">
          <div class="divider"></div>
          <label class="field"><span>Additional instructions / policies</span><textarea class="textarea" id="f-extra" rows="3" placeholder="Tone of voice, qualification criteria, escalation contacts, working hours…"></textarea></label>
          <label class="field"><span>Grant knowledge collections</span>
            ${collections.length ? `<div class="col gap-6">${collections.map((c) => `<label class="check"><input type="checkbox" data-coll="${c.id}">${esc(c.name)}</label>`).join('')}</div>` : '<span class="help">No collections yet — <a href="#/files">upload files</a> first.</span>'}
          </label>
          <label class="check"><input type="checkbox" id="f-noapproval"> Allow outbound actions without approval (not recommended)</label>
        </div>
      </div>
      <div class="col gap-16">
        <div class="card card-pad">
          <div class="between"><h3>Selected Integrations</h3><a class="small" href="#/integrations">Manage</a></div>
          <p class="help mt-4 mb-16">Choose the systems this employee will use. Unconnected systems can be connected later.</p>
          <div class="tiles" id="tiles">${INTEGRATIONS.map((i) => `<button class="tile ${selected.has(i.id) ? 'selected' : ''}" data-int="${i.id}">${sysIcon(i.id === 'web' ? 'web' : i.id)}<div class="grow"><div class="ellipsis">${esc(i.name)}</div><div class="tile-sub">${connections[i.id]?.status === 'connected' ? 'Connected' : i.id === 'web' ? 'Via extension' : 'Not connected'}</div></div></button>`).join('')}</div>
          <a class="link-btn mt-12" href="#/integrations">${icon('plus')} Add more integrations</a>
        </div>
        <div class="card card-pad between">
          <div class="row">${icon('puzzle')}<div><div class="strong">Browser Extension</div><div class="help">Allow the employee to work in browser tabs you select.</div></div></div>
          <label class="toggle"><input type="checkbox" id="f-browser"><span></span></label>
        </div>
        <button class="btn btn-primary btn-lg btn-block" id="generate" ${aiReady ? '' : 'disabled'}>${icon('sparkles')} Generate Employee ${icon('arrow-right')}</button>
      </div>
    </div>
  </div>`;

  const req = el.querySelector('#f-request');
  const count = () => { el.querySelector('#f-count').textContent = `${req.value.length}/4000`; };
  req.addEventListener('input', count);
  count();
  el.querySelector('#expert').addEventListener('change', (e) => { expert = e.target.checked; el.querySelector('#expert-box').hidden = !expert; });
  on(el, 'click', '[data-int]', (e, b) => {
    const id = b.dataset.int;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    b.classList.toggle('selected', selected.has(id));
  });

  el.querySelector('#generate').addEventListener('click', () => {
    const request = req.value.trim();
    if (request.length < 15) return toast('Describe the employee you need in a sentence or two.', 'error');
    const permissions = {};
    const constraints = [];
    for (const p of PERMS) {
      const checked = el.querySelector(`[data-perm="${p.key}"]`).checked;
      if (checked) p.apply(permissions); else { p.deny(permissions); if (p.text) constraints.push(`must NOT ${p.text}`); }
    }
    if (expert && el.querySelector('#f-noapproval').checked) {
      for (const scopes of Object.values(permissions)) for (const k of Object.keys(scopes)) if (scopes[k] === 'approval') scopes[k] = 'allow';
    }
    const systems = [...selected].flatMap((id) => INTEGRATIONS.find((i) => i.id === id)?.systems || []);
    const browser = el.querySelector('#f-browser').checked;
    const extra = expert ? el.querySelector('#f-extra').value.trim() : '';
    const fullRequest = [
      request,
      extra && `Additional policies: ${extra}`,
      systems.length && `Systems available: ${systems.map((s) => SYSTEMS[s].name).join(', ')}.`,
      constraints.length && `Owner constraints: the employee ${constraints.join('; ')}.`,
      browser && 'The employee should be able to work inside browser tabs through the WorkForce extension.',
    ].filter(Boolean).join('\n');
    const form = {
      name: el.querySelector('#f-name').value.trim(),
      role: el.querySelector('#f-role').value.trim(),
      systems: systems.map((s) => SYSTEMS[s].name),
      permissions, browser,
      collections: [...el.querySelectorAll('[data-coll]:checked')].map((c) => c.dataset.coll),
    };
    const job = startGeneration(app, { request: fullRequest, form });
    navigate(`/generate/${job}`);
  });
}

// ------------------------------------------------------------ generation screen
async function generationScreen(ctx) {
  const { el, app, params, navigate } = ctx;
  const job = app.jobs[params.job];
  if (!job) {
    el.innerHTML = `<div class="page"><div class="callout">${icon('info')}<div>This generation session is no longer active (generation state lives in the open tab). <a href="#/employees">View employees</a> or <a href="#/create">create a new one</a>.</div></div></div>`;
    return;
  }
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const employee = job.employeeId ? await app.db.get('employees', job.employeeId) : null;
    const done = GENERATION_STAGES.filter((s) => job.stages[s.id].status === 'done').length;
    el.innerHTML = `<div class="page">
      <a class="back" href="#/create">${icon('arrow-left')} Back</a>
      <div class="page-head"><div><h1>${employee ? `${esc(employee.name)} is ready` : job.status === 'error' ? 'Generation stopped' : 'Generating your employee…'}</h1>
      <p>${esc(job.request.split('\n')[0].slice(0, 220))}</p></div>
      ${employee ? `<div class="row"><a class="btn" href="#/employees/${employee.id}">${icon('settings-2')} Review &amp; edit</a><button class="btn btn-primary" id="deploy">${icon('rocket')} Deploy Employee</button></div>` : ''}</div>
      <div class="grid-2" style="grid-template-columns: 340px 1fr; align-items:start">
        <div class="card card-pad">
          <div class="between mb-16"><h3>Build progress</h3><span class="small muted">${done}/${GENERATION_STAGES.length}</span></div>
          <div class="meter mb-16"><span style="width:${(done / GENERATION_STAGES.length) * 100}%"></span></div>
          <div class="gen-list">${GENERATION_STAGES.map((s) => {
    const st = job.stages[s.id];
    return `<div class="gen-step ${st.status}"><span class="ic">${st.status === 'done' ? icon('check') : st.status === 'running' ? '<span class="spinner sm"></span>' : st.status === 'error' ? icon('x') : ''}</span><div class="grow"><div>${s.label}</div>${st.detail ? `<div class="tiny ${st.status === 'error' ? '' : 'muted'}">${esc(st.detail)}</div>` : ''}</div></div>`;
  }).join('')}
          <div class="gen-step ${employee ? 'done' : ''}"><span class="ic">${employee ? icon('check') : ''}</span><div><strong>Employee Ready</strong></div></div></div>
          ${job.status === 'error' ? `<div class="callout danger mt-16">${icon('alert-triangle')}<div><div class="small">${esc(job.error)}</div><div class="row mt-8"><button class="btn btn-sm" id="retry">${icon('refresh-cw')} Retry</button><a class="btn btn-sm btn-ghost" href="#/create?request=${encodeURIComponent(job.request.split('\n')[0])}">Edit request</a></div></div></div>` : ''}
        </div>
        <div id="arch">${employee ? archHtml(employee) : `<div class="card card-pad"><div class="empty">${job.status === 'error' ? '' : '<div class="spinner"></div>'}<h3>${job.status === 'error' ? 'Nothing was created' : 'The AI engine is designing the architecture'}</h3><p class="small">${job.status === 'error' ? 'Fix the issue and retry.' : 'Requirement analysis and architecture design are real model calls and can take a minute.'}</p></div></div>`}</div>
      </div></div>`;
    refreshIcons();
    if (employee) {
      renderWorkflow(el.querySelector('#wf'), employee, { compact: true });
      el.querySelector('#deploy').onclick = async () => {
        employee.status = 'active';
        employee.triggers.forEach((t) => { if (t.type === 'schedule') { t.enabled = true; t.nextRunAt = scheduleNext(t); } });
        await app.db.put('employees', employee);
        toast(`${employee.name} deployed`, 'success');
        navigate(`/employees/${employee.id}`);
      };
    }
    el.querySelector('#retry')?.addEventListener('click', () => navigate(`/generate/${startGeneration(app, { request: job.request, form: job.form })}`));
  };
  const off = app.events.on((e) => { if (e.type === 'job' && e.id === job.id) render(); });
  ctx.cleanup(off);
  await render();
}

function archHtml(e) {
  const tools = new Set(e.scripts.flatMap((s) => s.tools));
  const approvals = Object.values(e.permissions).flatMap((s) => Object.values(s)).filter((v) => v === 'approval').length;
  return `<div class="col gap-16">
    <div class="card card-pad">
      <div class="row">${avatar(e, 'avatar-lg')}<div class="grow"><h2>${esc(e.name)} — ${esc(e.role)}</h2><p class="muted small mt-4">${esc(e.summary)}</p></div>${statusBadge(e.status)}</div>
      <div class="stats mt-16">
        ${[['Scripts', e.scripts.length], ['Tools', tools.size], ['Systems', e.systems.length], ['Approval gates', approvals], ['Checks passed', `${e.tests.results.filter((r) => r.severity === 'pass').length}/${e.tests.results.length}`]].map(([l, v]) => `<div class="stat"><div class="stat-top">${l}</div><div class="stat-value">${v}</div></div>`).join('')}
      </div>
    </div>
    <div class="card"><div class="card-head"><h3>Workflow</h3><span class="small muted">Entry: ${esc(e.scripts.find((s) => s.id === e.entryScript)?.name || '')}</span></div><div class="card-body"><div id="wf"></div></div></div>
    <div class="card"><div class="card-head"><h3>Generated scripts</h3></div><div class="card-body col">
      ${e.scripts.map((s, i) => `<div class="row-top"><span class="num">${i + 1}</span><div class="grow"><div class="strong small">${esc(s.name)} ${s.approval.required ? '<span class="badge badge-warning">approval</span>' : ''}</div><div class="small muted">${esc(s.description)}</div><div class="mt-4">${s.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div></div>`).join('')}
    </div></div>
    <div class="card"><div class="card-head"><h3>Validation</h3>${e.tests.passed ? statusBadge('success', 'Passed') : statusBadge('failed')}</div><div class="card-body col gap-6">
      ${e.tests.results.map((r) => `<div class="row small"><span class="${r.severity === 'pass' ? 's-ok' : r.severity === 'warn' ? 's-wait' : 's-err'}">${icon(r.severity === 'pass' ? 'check-circle-2' : r.severity === 'warn' ? 'alert-triangle' : 'x-circle')}</span><span class="strong">${esc(r.name)}</span><span class="muted grow ellipsis">${esc(r.detail)}</span></div>`).join('')}
    </div></div>
    <div class="card"><div class="card-head"><h3>Permissions</h3><span class="small muted">Least privilege, derived from the scripts</span></div><div class="card-body row wrap">
      ${Object.entries(e.permissions).map(([sys, scopes]) => `<span class="chip">${sysIcon(sys, true)}${esc(SYSTEMS[sys]?.name || sys)}: ${Object.entries(scopes).map(([k, v]) => `<span class="lvl-${v}">${k} ${v === 'approval' ? '(approval)' : v === 'deny' ? '✕' : '✓'}</span>`).join(', ')}</span>`).join('') || '<span class="muted small">No external permissions</span>'}
    </div></div>
  </div>`;
}
