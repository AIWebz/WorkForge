import { esc, icon, on, toast, avatar, sysIcon, refreshIcons, statusBadge } from '../ui.js';
import { SYSTEMS, SCOPE_LABELS, allSystems } from '../../extension/core/catalog.js';
import { generateEmployee, GENERATION_STAGES } from '../../extension/core/generator.js';
import { scheduleNext } from '../../extension/core/employee.js';
import { uid } from '../../extension/core/util.js';
import { renderWorkflow } from './workflow.js';

// What the employee may do in the selected systems. Each maps to a scope that is
// applied to every selected system (files is the knowledge-file permission).
const PERMS = [
  { key: 'read', label: 'Read data in your systems', level: 'allow', text: 'read data in the systems' },
  { key: 'navigate', label: 'Move between pages', level: 'allow', text: 'move between pages' },
  { key: 'click', label: 'Click buttons (send, save…)', level: 'approval', text: 'click buttons (send, save, submit)' },
  { key: 'form_input', label: 'Type into forms', level: 'approval', text: 'type into forms' },
  { key: 'files', label: 'Read knowledge files', level: 'allow', text: 'read knowledge files' },
];
const SENSITIVE = new Set(['click', 'form_input']);
const VISIBLE_TILES = 6;

// Starting points for common jobs (the user can edit before generating).
const EXAMPLES = [
  ['Inbox triage', 'gmail', 'Every morning, go through new emails in Gmail, label and archive newsletters, draft replies to customer questions using our help docs, and ask me before sending anything.'],
  ['Lead follow-up', 'hubspot', 'When a new lead appears in HubSpot, research the company on LinkedIn, score the lead, add notes to the contact, and draft a personal follow-up email in Gmail for me to approve.'],
  ['Support desk', 'zendesk', 'Work through new Zendesk tickets: answer common questions using our knowledge files, tag and prioritise the rest, and escalate refunds or angry customers to me.'],
  ['Order check', 'shopify', 'Every afternoon, review new Shopify orders, flag anything unusual (high value, mismatched addresses), and post a short summary to our Slack channel.'],
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
      const [connections, collections] = await Promise.all([app.getConnections(), app.db.all('collections')]);
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

/** Turns selected system ids into the generation form fields (names for the prompt + ids). */
export function systemsForForm(ids, connections = []) {
  const all = allSystems(connections);
  const systemIds = ids.filter((id) => all[id]);
  return { systems: systemIds.map((id) => all[id].name), systemIds };
}

export default async function create(ctx) {
  if (ctx.params.job) return generationScreen(ctx);
  return createForm(ctx);
}

async function createForm({ el, app, navigate, query }) {
  const [rows, collections, aiReady] = await Promise.all([app.getConnections(), app.db.all('collections'), app.aiReady()]);
  const all = allSystems(rows);
  const connected = new Set(rows.filter((r) => all[r.id]).map((r) => r.id));
  const fromBusiness = (app.business?.systems || []).filter((id) => all[id]);
  const selected = new Set(connected.size ? connected : fromBusiness);
  // Connected first, then the systems the business uses, then the rest of the catalog.
  const order = [...new Set([...connected, ...fromBusiness, ...Object.keys(all)])];
  let showAll = false;
  let expert = false;
  const prefill = query.request || app.business?.automate || '';

  const tileHtml = (id, i) => {
    const s = all[id];
    const sub = connected.has(id) ? 'Connected' : s.address ? 'Needs your address' : 'Not connected yet';
    return `<button type="button" class="tile ${selected.has(id) ? 'selected' : ''}" data-sys="${esc(id)}" ${!showAll && i >= VISIBLE_TILES && !selected.has(id) ? 'hidden' : ''} aria-pressed="${selected.has(id)}">${sysIcon(id, false, s.name)}<div class="grow" style="min-width:0"><div class="ellipsis">${esc(s.name)}</div><div class="tile-sub">${sub}</div></div></button>`;
  };

  el.innerHTML = `<div class="page">
    <a class="back" href="#/employees">${icon('arrow-left')} Back to employees</a>
    <div class="page-head">
      <div><h1>Create an AI employee</h1><p>Describe the job. The AI engine designs the scripts, decisions, memory and permissions; the employee then works in your systems through the browser, signed in as you.</p></div>
      <div class="row small" style="border:1px solid var(--border);border-radius:999px;padding:6px 12px;background:var(--surface)">${icon('sliders-horizontal')} Advanced <label class="toggle"><input type="checkbox" id="expert" aria-label="Expert mode"><span></span></label></div>
    </div>
    ${aiReady ? '' : `<div class="callout warn mb-16">${icon('alert-triangle')}<div>This browser can't run the AI engine (it needs WebGPU). Open WorkForge in a recent Chrome, Edge or Brave on a computer with a GPU — <a href="#/settings/ai">details</a>.</div></div>`}
    <div class="grid-2" style="grid-template-columns: 1.15fr 1fr; align-items:start">
      <div class="card card-pad form-grid">
        <div class="form-row">
          <label class="field"><span>Employee name</span><div class="input-icon">${icon('user')}<input class="input" id="f-name" placeholder="e.g. Alex (optional)"></div></label>
          <label class="field"><span>Role / job title</span><input class="input" id="f-role" placeholder="e.g. Sales assistant (optional)"></label>
        </div>
        <label class="field"><span>What should this employee do?</span>
          <textarea class="textarea" id="f-request" rows="7" maxlength="4000" placeholder="Every morning, go through new support emails in Gmail, look up the customer in HubSpot, draft a reply using our help docs and ask me before sending. Escalate refunds over $200.">${esc(prefill)}</textarea>
          <div class="between"><span class="help">Describe the work, where it happens, the decisions it makes and what needs your approval.</span><span class="help" id="f-count">0/4000</span></div>
        </label>
        <div class="examples"><span class="tiny muted">Start from an example</span>${EXAMPLES.map(([t, sys], i) => `<button type="button" class="chip example" data-example="${i}">${sysIcon(sys, true)}${esc(t)}</button>`).join('')}</div>
        <p class="help row gap-6">${icon('shield-check')} It reads and moves around your systems freely, and asks you before it clicks or types anything. Change this in Advanced.</p>
        <div id="expert-box" hidden class="form-grid">
          <div class="divider"></div>
          <div><div class="label mb-8">What it may do</div>
          <div class="grid-2" style="gap:8px">${PERMS.map((p) => `<label class="check"><input type="checkbox" data-perm="${p.key}" checked>${p.label}${SENSITIVE.has(p.key) ? ' <span class="badge badge-warning" style="margin-left:4px">approval</span>' : ''}</label>`).join('')}</div></div>
          <label class="field"><span>Additional instructions / policies</span><textarea class="textarea" id="f-extra" rows="3" placeholder="Tone of voice, qualification criteria, escalation contacts, working hours…"></textarea></label>
          <label class="field"><span>Grant knowledge collections</span>
            ${collections.length ? `<div class="col gap-6">${collections.map((c) => `<label class="check"><input type="checkbox" data-coll="${esc(c.id)}">${esc(c.name)}</label>`).join('')}</div>` : '<span class="help">No collections yet — <a href="#/files">upload files</a> first.</span>'}
          </label>
          <label class="check" style="align-items:flex-start"><input type="checkbox" id="f-noapproval"><div><div>Let it click and type without asking me first</div><div class="help">Not recommended. The employee could send emails, save records or submit forms on its own.</div></div></label>
          <div class="callout danger" id="noapproval-warn" hidden>${icon('alert-triangle')}<div class="small">Clicks and form input will run without approval in every selected system. You can still require approval for everything in Settings → Security.</div></div>
        </div>
      </div>
      <div class="col gap-16">
        <div class="card card-pad">
          <div class="between"><h3>Systems it works in</h3><a class="small" href="#/systems">Manage systems</a></div>
          <p class="help mt-4 mb-16">Pick the web apps this job happens in. The employee opens them in a tab with your login.</p>
          <div class="tiles" id="tiles">${order.map(tileHtml).join('')}</div>
          ${order.length > VISIBLE_TILES ? `<button type="button" class="link-btn mt-12" id="more">${icon('chevron-down')} Show all ${order.length} systems</button>` : ''}
        </div>
        ${app.bridge.paired ? '' : `<p class="help row gap-6">${icon('puzzle')} Employees work through the <a href="#/extension">WorkForge browser extension</a>.</p>`}
        <button class="btn btn-primary btn-lg btn-block" id="generate" ${aiReady ? '' : 'disabled'}>${icon('sparkles')} Generate employee ${icon('arrow-right')}</button>
      </div>
    </div>
  </div>`;

  const req = el.querySelector('#f-request');
  el.querySelectorAll('[data-example]').forEach((b) => b.onclick = () => {
    const [, sys, text] = EXAMPLES[Number(b.dataset.example)];
    req.value = text;
    req.dispatchEvent(new Event('input'));
    const tile = el.querySelector(`[data-sys="${sys}"]`);
    if (tile && !tile.classList.contains('selected')) tile.click();
    req.focus();
  });
  const count = () => { el.querySelector('#f-count').textContent = `${req.value.length}/4000`; };
  req.addEventListener('input', count);
  count();
  el.querySelector('#expert').addEventListener('change', (e) => { expert = e.target.checked; el.querySelector('#expert-box').hidden = !expert; });
  el.querySelector('#f-noapproval').addEventListener('change', (e) => { el.querySelector('#noapproval-warn').hidden = !e.target.checked; });
  el.querySelector('#more')?.addEventListener('click', (e) => {
    showAll = !showAll;
    el.querySelectorAll('[data-sys]').forEach((t, i) => { t.hidden = !showAll && i >= VISIBLE_TILES && !selected.has(t.dataset.sys); });
    e.currentTarget.innerHTML = showAll ? `${icon('chevron-up')} Show fewer` : `${icon('chevron-down')} Show all ${order.length} systems`;
    refreshIcons();
  });
  on(el, 'click', '[data-sys]', (e, b) => {
    const id = b.dataset.sys;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    b.classList.toggle('selected', selected.has(id));
    b.setAttribute('aria-pressed', String(selected.has(id)));
    if (selected.has(id)) b.hidden = false;
  });

  el.querySelector('#generate').addEventListener('click', () => {
    const request = req.value.trim();
    if (request.length < 15) return toast('Describe the employee you need in a sentence or two.', 'error');
    const ids = order.filter((id) => selected.has(id));
    const checked = Object.fromEntries(PERMS.map((p) => [p.key, el.querySelector(`[data-perm="${p.key}"]`).checked]));
    const noApproval = expert && el.querySelector('#f-noapproval').checked;
    const levels = {};
    for (const p of PERMS) {
      if (p.key === 'files') continue;
      levels[p.key] = !checked[p.key] ? 'deny' : SENSITIVE.has(p.key) && noApproval ? 'allow' : p.level;
    }
    const permissions = Object.fromEntries(ids.map((id) => [id, { ...levels }]));
    permissions.files = { read: checked.files ? 'allow' : 'deny' };
    const constraints = PERMS.filter((p) => !checked[p.key]).map((p) => `must NOT ${p.text}`);
    const { systems, systemIds } = systemsForForm(ids, rows);
    const extra = expert ? el.querySelector('#f-extra').value.trim() : '';
    const fullRequest = [
      request,
      extra && `Additional policies: ${extra}`,
      systems.length && `Systems it works in (through the browser, with the owner's login): ${systems.join(', ')}.`,
      constraints.length && `Owner constraints: the employee ${constraints.join('; ')}.`,
    ].filter(Boolean).join('\n');
    const form = {
      name: el.querySelector('#f-name').value.trim(),
      role: el.querySelector('#f-role').value.trim(),
      systems, systemIds, permissions,
      collections: [...el.querySelectorAll('[data-coll]:checked')].map((c) => c.dataset.coll),
    };
    const job = startGeneration(app, { request: fullRequest, form });
    navigate(`/generate/${job}`);
  });
  refreshIcons();
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
    const [employee, rows] = await Promise.all([job.employeeId ? app.db.get('employees', job.employeeId) : null, app.getConnections()]);
    const done = GENERATION_STAGES.filter((s) => job.stages[s.id].status === 'done').length;
    el.innerHTML = `<div class="page">
      <a class="back" href="#/create">${icon('arrow-left')} Back</a>
      <div class="page-head"><div><h1>${employee ? `${esc(employee.name)} is ready` : job.status === 'error' ? 'Generation stopped' : 'Generating your employee…'}</h1>
      <p>${esc(job.request.split('\n')[0].slice(0, 220))}</p></div>
      ${employee ? `<div class="row"><a class="btn" href="#/employees/${esc(employee.id)}">${icon('settings-2')} Review &amp; edit</a><button class="btn btn-primary" id="deploy">${icon('rocket')} Deploy employee</button></div>` : ''}</div>
      <div class="grid-2" style="grid-template-columns: 340px 1fr; align-items:start">
        <div class="card card-pad">
          <div class="between mb-16"><h3>Build progress</h3><span class="small muted">${done}/${GENERATION_STAGES.length}</span></div>
          <div class="meter mb-16"><span style="width:${(done / GENERATION_STAGES.length) * 100}%"></span></div>
          <div class="gen-list">${GENERATION_STAGES.map((s) => {
    const st = job.stages[s.id];
    return `<div class="gen-step ${st.status}"><span class="ic">${st.status === 'done' ? icon('check') : st.status === 'running' ? '<span class="spinner sm"></span>' : st.status === 'error' ? icon('x') : ''}</span><div class="grow"><div>${s.label}</div>${st.detail ? `<div class="tiny ${st.status === 'error' ? '' : 'muted'}">${esc(st.detail)}</div>` : ''}</div></div>`;
  }).join('')}
          <div class="gen-step ${employee ? 'done' : ''}"><span class="ic">${employee ? icon('check') : ''}</span><div><strong>Employee ready</strong></div></div></div>
          ${job.status === 'error' ? `<div class="callout danger mt-16">${icon('alert-triangle')}<div><div class="small">${esc(job.error)}</div><div class="row mt-8"><button class="btn btn-sm" id="retry">${icon('refresh-cw')} Retry</button><a class="btn btn-sm btn-ghost" href="#/create?request=${encodeURIComponent(job.request.split('\n')[0])}">Edit request</a></div></div></div>` : ''}
        </div>
        <div id="arch">${employee ? archHtml(employee, rows) : `<div class="card card-pad"><div class="empty">${job.status === 'error' ? '' : '<div class="spinner"></div>'}<h3>${job.status === 'error' ? 'Nothing was created' : 'The AI engine is designing the architecture'}</h3><p class="small">${job.status === 'error' ? 'Fix the issue and retry.' : 'Requirement analysis and architecture design are real model calls and can take a minute.'}</p></div></div>`}</div>
      </div></div>`;
    refreshIcons();
    if (employee) {
      renderWorkflow(el.querySelector('#wf'), employee, { compact: true, connections: rows });
      el.querySelector('#deploy').onclick = async () => {
        employee.status = 'active';
        (employee.triggers || []).forEach((t) => { if (t.type === 'schedule') { t.enabled = true; t.nextRunAt = scheduleNext(t); } });
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

const LEVEL_TEXT = { allow: '✓', approval: '(approval)', deny: '✕' };

function archHtml(e, rows = []) {
  const all = allSystems(rows);
  const connected = new Set(rows.map((r) => r.id));
  const sysName = (id) => all[id]?.name || SYSTEMS[id]?.name || id;
  const systems = e.systems || Object.keys(e.permissions || {}).filter((k) => k !== 'files');
  const tools = new Set((e.scripts || []).flatMap((s) => s.tools || []));
  const approvals = Object.values(e.permissions || {}).flatMap((s) => Object.values(s)).filter((v) => v === 'approval').length;
  const results = e.tests?.results || [];
  const missing = systems.filter((id) => !connected.has(id));
  return `<div class="col gap-16">
    <div class="card card-pad">
      <div class="row">${avatar(e, 'avatar-lg')}<div class="grow"><h2>${esc(e.name)} — ${esc(e.role)}</h2><p class="muted small mt-4">${esc(e.summary)}</p></div>${statusBadge(e.status)}</div>
      <div class="stats mt-16">
        ${[['Scripts', (e.scripts || []).length], ['Tools', tools.size], ['Systems', systems.length], ['Approval gates', approvals], ['Checks passed', `${results.filter((r) => r.severity === 'pass').length}/${results.length}`]].map(([l, v]) => `<div class="stat"><div class="stat-top">${l}</div><div class="stat-value">${v}</div></div>`).join('')}
      </div>
    </div>
    <div class="card"><div class="card-head"><h3>Works in</h3><a class="small" href="#/systems">Systems</a></div><div class="card-body col gap-6">
      ${systems.length ? `<div class="row wrap">${systems.map((id) => `<span class="chip">${sysIcon(id, true, sysName(id))}${esc(sysName(id))}${connected.has(id) ? '' : ' <span class="tiny s-wait">not connected</span>'}</span>`).join('')}</div>` : '<span class="muted small">No systems — this employee works only with memory and knowledge files.</span>'}
      ${missing.length ? `<div class="callout warn mt-8">${icon('plug')}<div class="small">Connect ${missing.map((id) => esc(sysName(id))).join(', ')} in <a href="#/systems">Systems</a> before deploying so the employee can open ${missing.length === 1 ? 'it' : 'them'}.</div></div>` : ''}
    </div></div>
    <div class="card"><div class="card-head"><h3>Workflow</h3><span class="small muted">Entry: ${esc((e.scripts || []).find((s) => s.id === e.entryScript)?.name || '')}</span></div><div class="card-body"><div id="wf"></div></div></div>
    <div class="card"><div class="card-head"><h3>Generated scripts</h3></div><div class="card-body col">
      ${(e.scripts || []).map((s, i) => `<div class="row-top"><span class="num">${i + 1}</span><div class="grow"><div class="strong small row gap-6">${esc(s.name)} ${(s.systems || []).map((id) => sysIcon(id, true, sysName(id))).join('')} ${s.approval?.required ? '<span class="badge badge-warning">approval</span>' : ''}</div><div class="small muted">${esc(s.description)}</div><div class="mt-4">${(s.tools || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div></div>`).join('')}
    </div></div>
    <div class="card"><div class="card-head"><h3>Validation</h3>${e.tests?.passed ? statusBadge('success', 'Passed') : statusBadge('failed')}</div><div class="card-body col gap-6">
      ${results.map((r) => `<div class="row small"><span class="${r.severity === 'pass' ? 's-ok' : r.severity === 'warn' ? 's-wait' : 's-err'}">${icon(r.severity === 'pass' ? 'check-circle-2' : r.severity === 'warn' ? 'alert-triangle' : 'x-circle')}</span><span class="strong">${esc(r.name)}</span><span class="muted grow ellipsis">${esc(r.detail)}</span></div>`).join('')}
    </div></div>
    <div class="card"><div class="card-head"><h3>Permissions</h3><span class="small muted">Least privilege, derived from the scripts</span></div><div class="card-body col gap-6">
      ${Object.entries(e.permissions || {}).map(([sys, scopes]) => `<div class="row wrap small"><span class="chip">${sysIcon(sys, true, sys === 'files' ? 'Knowledge files' : sysName(sys))}${esc(sys === 'files' ? 'Knowledge files' : sysName(sys))}</span>${Object.entries(scopes).map(([k, v]) => `<span class="lvl-${esc(v)}">${esc(SCOPE_LABELS[k] || k)} ${LEVEL_TEXT[v] || esc(v)}</span>`).join('<span class="faint">·</span>')}</div>`).join('') || '<span class="muted small">No permissions</span>'}
      ${e.browser?.domains?.length ? `<div class="row wrap small"><span class="chip">${sysIcon('web', true)}Other websites (read only)</span>${e.browser.domains.map((d) => `<code>${esc(d)}</code>`).join(' ')}</div>` : ''}
    </div></div>
  </div>`;
}
