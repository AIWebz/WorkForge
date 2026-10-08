// Visual workflow graph + script editor shared by the generation screen and the
// employee profile.
import { esc, icon, modal, toast, refreshIcons, sysIcon, $$ } from '../ui.js';
import { workflowLayout, normalizeScript, validateEmployee } from '../../extension/core/employee.js';
import { TOOLS, TOOL_MAP, SYSTEM_GROUPS, DEFAULT_SCOPE_LEVELS, allSystems } from '../../extension/core/catalog.js';
import { saveVersion } from '../../extension/core/modifier.js';
import { clone, uid, now } from '../../extension/core/util.js';

const NODE_W = 200;
const NODE_H = 88;
const COL_W = 330;
const ROW_H = 124;
const PAD = 28;

// Permission keys that are not systems (files is knowledge; browser/web are legacy keys).
const NON_SYSTEM_KEYS = new Set(['files', 'browser', 'web']);

/** Systems an employee may work in: the keys of its permissions that are systems. */
export function employeeSystemIds(employee, connections = []) {
  const all = allSystems(connections);
  return Object.keys(employee?.permissions || {}).filter((k) => !NON_SYSTEM_KEYS.has(k) && (all[k] || k.startsWith('custom_')));
}

/** Display name for a system id, including custom web apps. */
export function systemName(id, connections = []) {
  return allSystems(connections)[id]?.name || String(id).replace(/^custom_/, '').replace(/[_-]+/g, ' ');
}

/** A row of small system logos, max `max` then "+N". */
export function systemLogos(ids = [], connections = [], max = 5) {
  const list = [...new Set(ids)];
  if (!list.length) return '';
  const shown = list.slice(0, max).map((id) => sysIcon(id, true, systemName(id, connections))).join('');
  const more = list.length > max ? `<span class="sys-more tiny muted strong" title="${esc(list.slice(max).map((id) => systemName(id, connections)).join(', '))}">+${list.length - max}</span>` : '';
  return `<span class="sys-logos row gap-4">${shown}${more}</span>`;
}

export function renderWorkflow(container, employee, { selected = null, running = null, onSelect = null, compact = false, connections = [] } = {}) {
  if (!container) return;
  const { layers, edges } = workflowLayout(employee);
  const byId = Object.fromEntries(employee.scripts.map((s) => [s.id, s]));
  const pos = {};
  const maxRows = Math.max(1, ...layers.map((l) => l.length));
  layers.forEach((layer, li) => {
    const offset = ((maxRows - layer.length) * ROW_H) / 2;
    layer.forEach((id, ri) => { pos[id] = { x: PAD + li * COL_W, y: PAD + offset + ri * ROW_H, layer: li }; });
  });
  const width = PAD * 2 + Math.max(1, layers.length) * COL_W - (COL_W - NODE_W);
  const hasBack = edges.some((e) => pos[e.to] && pos[e.from] && pos[e.to].layer <= pos[e.from].layer);
  const height = PAD * 2 + maxRows * ROW_H - (ROW_H - NODE_H) + (hasBack ? 70 : 0);

  const paths = [];
  const labels = [];
  for (const e of edges) {
    const a = pos[e.from];
    const b = pos[e.to];
    if (!a || !b) continue;
    let d;
    let mid;
    if (b.layer > a.layer) {
      const x1 = a.x + NODE_W; const y1 = a.y + NODE_H / 2; const x2 = b.x - 6; const y2 = b.y + NODE_H / 2;
      const c = (x2 - x1) / 2;
      d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
      mid = { x: (x1 + 3 * (x1 + c) + 3 * (x2 - c) + x2) / 8, y: (y1 + 3 * y1 + 3 * y2 + y2) / 8 };
    } else {
      const x1 = a.x + NODE_W / 2; const y1 = a.y + NODE_H; const x2 = b.x + NODE_W / 2 + 12; const y2 = b.y + NODE_H + 6;
      const low = Math.max(y1, y2) + 52;
      d = `M${x1},${y1} C${x1},${low} ${x2},${low} ${x2},${y2}`;
      mid = { x: (x1 + x2) / 2, y: low - 12 };
    }
    const active = running && e.from === running;
    paths.push(`<path d="${d}" fill="none" stroke="${active ? '#6366f1' : '#c3c8d8'}" stroke-width="${active ? 2 : 1.5}" marker-end="url(#arrow)" ${b.layer <= a.layer ? 'stroke-dasharray="5 4"' : ''}/>`);
    if (e.condition && !compact) labels.push(`<div class="wf-edge-label" style="left:${mid.x - 56}px;top:${mid.y - 9}px" title="${esc(e.condition)}">${esc(e.condition)}</div>`);
  }

  container.innerHTML = `<div class="wf-wrap" style="min-height:${Math.min(height + 4, compact ? 420 : 900)}px">
    <div style="position:relative;width:${width}px;height:${height}px">
      <svg class="wf-svg" width="${width}" height="${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#aab1c5"/></marker></defs>${paths.join('')}</svg>
      ${labels.join('')}
      ${employee.scripts.map((s) => {
    const p = pos[s.id];
    return `<div class="wf-node ${s.id === employee.entryScript ? 'entry' : ''} ${s.id === selected ? 'selected' : ''} ${s.id === running ? 'running' : ''}" data-node="${s.id}" style="left:${p.x}px;top:${p.y}px">
          <div class="wf-title">${s.id === employee.entryScript ? icon('play') : ''}<span class="ellipsis">${esc(s.name)}</span></div>
          <div class="wf-sub">${esc(s.description || s.purpose)}</div>
          <div class="wf-meta">${systemLogos(s.systems || [], connections, 4)}${s.approval.required ? '<span class="badge badge-warning">approval</span>' : ''}${s.tools.length ? `<span class="badge">${s.tools.length} tools</span>` : ''}${!s.next.length ? '<span class="badge badge-success">end</span>' : ''}</div>
        </div>`;
  }).join('')}
    </div></div>`;
  refreshIcons();
  if (onSelect) $$('[data-node]', container).forEach((n) => n.addEventListener('click', () => onSelect(n.dataset.node)));
  void byId;
}

// ------------------------------------------------------------ script editor
const fieldLines = (arr) => arr.map((f) => `${f.name}: ${f.type}${f.description ? ` — ${f.description}` : ''}`).join('\n');
const parseFields = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const m = l.match(/^([^:]+):\s*([^—-]+?)\s*(?:[—-]\s*(.*))?$/);
  return m ? { name: m[1].trim(), type: m[2].trim(), description: (m[3] || '').trim() } : { name: l, type: 'string', description: '' };
});

const TOOL_GROUPS = [['files', 'Knowledge files'], ['browser', 'Browser']];

export async function openScriptEditor(app, employee, scriptId, onSaved) {
  const isNew = !scriptId;
  const s = isNew
    ? normalizeScript({ name: 'New Script', description: '', failure: { strategy: 'escalate' } }, employee.scripts.length, new Set(employee.scripts.map((x) => x.id)))
    : clone(employee.scripts.find((x) => x.id === scriptId));
  s.systems = [...(s.systems || [])];
  const others = employee.scripts.filter((x) => x.id !== s.id);
  const connections = await app.getConnections();
  const all = allSystems(connections);
  const connected = new Set(connections.map((c) => c.id));
  const granted = new Set(employeeSystemIds(employee, connections));
  const chosen = new Set(s.systems);
  // Chosen first, then the employee's systems, then connected ones, then the catalog by group.
  const groupRank = (id) => { const g = SYSTEM_GROUPS.indexOf(all[id]?.group); return g === -1 ? SYSTEM_GROUPS.length : g; };
  const rank = (id) => (chosen.has(id) ? 3 : granted.has(id) ? 2 : connected.has(id) ? 1 : 0);
  const sysIds = Object.keys(all).sort((a, b) => rank(b) - rank(a) || groupRank(a) - groupRank(b) || all[a].name.localeCompare(all[b].name));
  const sysChip = (id) => `<label class="check small sys-pick" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);border-radius:8px" title="${esc(all[id].description || '')}">
      <input type="checkbox" data-sys="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}>${sysIcon(id, true, all[id].name)}<span class="ellipsis">${esc(all[id].name)}</span>${connected.has(id) ? '' : '<span class="tiny muted" style="margin-left:auto">not connected</span>'}</label>`;

  const nextRow = (n = { script: '', condition: '' }) => `<div class="row next-row"><select class="select select-sm" style="width:200px" data-next-script>${others.map((o) => `<option value="${o.id}" ${o.id === n.script ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select><input class="input" style="height:30px;padding:4px 8px;font-size:12.5px" data-next-cond placeholder="Condition, e.g. lead score ≥ 70" value="${esc(n.condition)}"><button class="btn btn-xs btn-ghost" data-rm-next>${icon('x')}</button></div>`;

  const body = `<div class="form-grid">
    <div class="form-row"><label class="field"><span>Name</span><input class="input" id="s-name" value="${esc(s.name)}"></label>
    <label class="field"><span>Estimated manual minutes</span><input class="input" type="number" min="0" id="s-min" value="${s.estimatedMinutes}"></label></div>
    <label class="field"><span>Description</span><input class="input" id="s-desc" value="${esc(s.description)}"></label>
    <label class="field"><span>Purpose</span><input class="input" id="s-purpose" value="${esc(s.purpose)}"></label>
    <label class="field"><span>Instructions (what the AI engine does when running this script)</span><textarea class="textarea" id="s-instr" rows="5">${esc(s.instructions)}</textarea></label>
    <div class="form-row"><label class="field"><span>Inputs <span class="help">name: type — description</span></span><textarea class="textarea" id="s-in" rows="3">${esc(fieldLines(s.inputs))}</textarea></label>
    <label class="field"><span>Outputs</span><textarea class="textarea" id="s-out" rows="3">${esc(fieldLines(s.outputs))}</textarea></label></div>
    <div class="form-row"><label class="field"><span>Trigger</span><input class="input" id="s-trigger" value="${esc(s.trigger)}"></label>
    <label class="field"><span>Conditions (one per line)</span><textarea class="textarea" id="s-cond" rows="2" style="min-height:40px">${esc(s.conditions.join('\n'))}</textarea></label></div>
    <div class="field"><span>Systems</span><div class="sys-pick-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;max-height:210px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">
      ${sysIds.map(sysChip).join('')}
    </div><span class="help">Web apps this script works in through the WorkForge extension, signed in as you. Systems new to ${esc(employee.name)} get default access — Read and Navigate allowed, Click and Type &amp; submit need approval. Adjust it under Permissions.</span></div>
    <div class="field"><span>Tools</span><div class="col gap-6" style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">
      ${TOOL_GROUPS.map(([sys, label]) => `<div><div class="row gap-6 tiny muted strong">${sysIcon(sys, true)}${label}</div><div class="row wrap gap-6 mt-4">${TOOLS.filter((t) => t.system === sys).map((t) => `<label class="check small" title="${esc(t.description)}"><input type="checkbox" data-tool="${t.name}" ${s.tools.includes(t.name) ? 'checked' : ''}>${t.name}</label>`).join('')}</div></div>`).join('')}
    </div><span class="help">Memory, metrics, escalation, scheduling and notifications are always available. A script with systems but no browser tools gets browser_open and browser_read_page.</span></div>
    <div class="field"><span>Next scripts (decision logic)</span><div id="next-list" class="col gap-6">${s.next.map(nextRow).join('')}</div>${others.length ? '<button class="link-btn" id="add-next">+ Add transition</button>' : ''}</div>
    <div class="form-row">
      <label class="field"><span>On failure</span><select class="select" id="s-fail">${['retry', 'escalate', 'skip', 'stop'].map((x) => `<option ${s.failure.strategy === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field"><span>Escalate to</span><select class="select" id="s-esc"><option value="">(automatic)</option>${others.map((o) => `<option value="${o.id}" ${s.failure.escalateTo === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
    </div>
    <div class="form-row"><label class="field"><span>Max retries</span><input class="input" type="number" min="0" max="3" id="s-retries" value="${s.failure.maxRetries}"></label>
    <label class="field"><span>Human approval</span><label class="check"><input type="checkbox" id="s-appr" ${s.approval.required ? 'checked' : ''}> Require approval for every outbound action in this script</label></label></div>
    <label class="field"><span>Approval reason</span><input class="input" id="s-appr-reason" value="${esc(s.approval.reason)}"></label>
  </div>`;

  modal({
    title: isNew ? 'Add script' : `Edit ${s.name}`,
    subtitle: `Script id: <code>${esc(s.id)}</code>`,
    wide: true,
    body,
    onMount(m) {
      m.querySelector('#add-next')?.addEventListener('click', () => { m.querySelector('#next-list').insertAdjacentHTML('beforeend', nextRow()); refreshIcons(); });
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-rm-next]'); if (b) b.closest('.next-row').remove(); });
    },
    actions: [
      ...(isNew ? [] : [{ label: 'Delete script', danger: true, icon: 'trash-2', onClick: async () => {
        if (employee.scripts.length <= 1) throw new Error('An employee needs at least one script');
        const { applyOperations } = await import('../../extension/core/modifier.js');
        const { employee: updated } = applyOperations(employee, [{ op: 'remove_script', id: s.id }]);
        await persist(app, employee, updated, `Removed script ${s.name}`);
        onSaved && onSaved(updated);
      } }]),
      { label: 'Cancel' },
      { label: isNew ? 'Add script' : 'Save script', primary: true, onClick: async (m) => {
        const v = (id) => m.querySelector(id).value;
        const systems = [...m.querySelectorAll('[data-sys]:checked')].map((c) => c.dataset.sys).filter((id) => all[id]);
        let tools = [...m.querySelectorAll('[data-tool]:checked')].map((c) => c.dataset.tool);
        if (systems.length && !tools.some((t) => TOOL_MAP[t]?.system === 'browser')) tools = [...tools, 'browser_open', 'browser_read_page'];
        const updatedScript = {
          ...s,
          name: v('#s-name').trim() || s.name,
          description: v('#s-desc'), purpose: v('#s-purpose'), instructions: v('#s-instr'), trigger: v('#s-trigger'),
          inputs: parseFields(v('#s-in')), outputs: parseFields(v('#s-out')),
          conditions: v('#s-cond').split('\n').map((x) => x.trim()).filter(Boolean),
          systems,
          tools,
          next: [...m.querySelectorAll('.next-row')].map((r) => ({ script: r.querySelector('[data-next-script]').value, condition: r.querySelector('[data-next-cond]').value.trim() })).filter((n) => n.script),
          failure: { ...s.failure, strategy: v('#s-fail'), escalateTo: v('#s-esc'), maxRetries: Math.min(3, Math.max(0, Number(v('#s-retries')) || 0)) },
          approval: { required: m.querySelector('#s-appr').checked, reason: v('#s-appr-reason') },
          estimatedMinutes: Math.max(0, Number(v('#s-min')) || 0),
        };
        const clean = normalizeScript(updatedScript, 0, new Set());
        clean.id = s.id;
        clean.systems = systems;
        clean.next = clean.next.filter((n, i, a) => a.findIndex((x) => x.script === n.script) === i);
        const updated = clone(employee);
        if (isNew) updated.scripts.push(clean);
        else updated.scripts = updated.scripts.map((x) => (x.id === s.id ? clean : x));
        // Systems new to this employee get the default scope levels (click / type start as approval-required).
        updated.permissions = updated.permissions || {};
        const added = systems.filter((id) => !updated.permissions[id]);
        for (const id of added) updated.permissions[id] = { ...DEFAULT_SCOPE_LEVELS };
        if (clean.tools.some((t) => TOOL_MAP[t]?.system === 'files') && !updated.permissions.files) updated.permissions.files = { read: 'allow' };
        await persist(app, employee, updated, `${isNew ? 'Added' : 'Edited'} script ${clean.name}${added.length ? ` · granted ${added.map((id) => all[id].name).join(', ')} (default access)` : ''}`);
        onSaved && onSaved(updated);
      } },
    ],
  });
}

export async function persist(app, before, updated, reason) {
  const connections = await app.getConnections();
  await saveVersion(app.db, before, reason);
  updated.version = (before.version || 1) + 1;
  updated.updatedAt = now();
  updated.systems = employeeSystemIds(updated, connections);
  updated.browser = { ...(updated.browser || {}), domains: [...(updated.browser?.domains || [])] };
  delete updated.browser.enabled;
  updated.tests = validateEmployee(updated, { connections, collections: await app.db.all('collections') });
  await app.db.put('employees', updated);
  await app.db.put('activity', { id: uid('act'), ts: now(), employeeId: updated.id, taskId: null, origin: 'app', type: 'config_changed', status: 'info', message: `Configuration changed: ${reason}` });
  toast(reason, 'success');
  return updated;
}
