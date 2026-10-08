// Employee architecture: normalization of AI output, permission evaluation,
// workflow graph helpers and the validation suite run before deployment.
import { TOOL_MAP, SYSTEMS, CONNECTIONS, SENSITIVE_SCOPES, toolScope } from './catalog.js';
import { slug, uid, now } from './util.js';

const COLORS = ['#6366F1', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6'];
const LEVELS = new Set(['allow', 'approval', 'deny']);

export function initials(name) {
  return String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function arr(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function strs(v) { return arr(v).map((x) => (typeof x === 'string' ? x : x?.text || x?.description || JSON.stringify(x))).filter(Boolean); }
function fields(v) {
  return arr(v).map((f) => (typeof f === 'string' ? { name: f, type: 'string', description: '' } : {
    name: String(f.name || f.key || 'value'), type: String(f.type || 'string'), description: String(f.description || ''),
  }));
}

export function normalizeScript(s, idx, usedIds) {
  let id = slug(s.id || s.name || `script_${idx + 1}`, `script_${idx + 1}`);
  while (usedIds.has(id)) id = `${id}_${idx + 1}`;
  usedIds.add(id);
  const failure = s.failure || s.failureBehavior || s.error_handling || {};
  const approval = s.approval || s.humanApproval || {};
  return {
    id,
    name: String(s.name || id.replace(/_/g, ' ')),
    description: String(s.description || ''),
    purpose: String(s.purpose || s.description || ''),
    instructions: String(s.instructions || s.steps?.join?.('\n') || s.logic || ''),
    inputs: fields(s.inputs),
    outputs: fields(s.outputs),
    trigger: String(s.trigger || ''),
    conditions: strs(s.conditions),
    tools: [...new Set(arr(s.tools).map(String).filter((t) => TOOL_MAP[t] && !TOOL_MAP[t].internal))],
    dependencies: arr(s.dependencies).map((d) => slug(d)),
    next: arr(s.next || s.nextScripts || s.next_possible_scripts).map((n) => (typeof n === 'string'
      ? { script: slug(n), condition: '' }
      : { script: slug(n.script || n.id || n.to || ''), condition: String(n.condition || n.when || '') })).filter((n) => n.script),
    failure: {
      strategy: ['retry', 'escalate', 'skip', 'stop'].includes(failure.strategy) ? failure.strategy : (typeof failure === 'string' && /retry/i.test(failure) ? 'retry' : 'escalate'),
      maxRetries: Math.min(3, Math.max(0, Number(failure.maxRetries ?? failure.max_retries ?? 1) || 0)),
      escalateTo: failure.escalateTo || failure.escalate_to ? slug(failure.escalateTo || failure.escalate_to) : '',
      notes: String(failure.notes || (typeof failure === 'string' ? failure : '')),
    },
    approval: {
      required: !!(approval.required ?? (typeof approval === 'boolean' ? approval : false)),
      reason: String(approval.reason || ''),
    },
    estimatedMinutes: Math.max(0, Math.min(240, Number(s.estimatedMinutes ?? s.estimated_minutes ?? 5) || 0)),
  };
}

export function normalizeEmployee(raw, { request = '', business = {}, preferences = {} } = {}) {
  const used = new Set();
  const scripts = arr(raw.scripts).map((s, i) => normalizeScript(s, i, used));
  const ids = new Set(scripts.map((s) => s.id));
  for (const s of scripts) {
    s.next = s.next.filter((n) => n.script === 'end' || ids.has(n.script)).map((n) => (n.script === 'end' ? null : n)).filter(Boolean);
    s.dependencies = s.dependencies.filter((d) => ids.has(d));
    if (s.failure.escalateTo && !ids.has(s.failure.escalateTo)) s.failure.escalateTo = '';
  }
  const entry = ids.has(slug(raw.entryScript || raw.entry_script || '')) ? slug(raw.entryScript || raw.entry_script) : scripts[0]?.id;
  const name = String(raw.name || 'New Employee').split(/[—–-]/)[0].trim() || 'Employee';
  const color = raw.avatarColor && /^#[0-9a-f]{6}$/i.test(raw.avatarColor) ? raw.avatarColor : COLORS[Math.floor(Math.random() * COLORS.length)];

  const employee = {
    id: uid('emp'),
    name,
    role: String(raw.role || raw.title || 'AI Employee'),
    summary: String(raw.summary || raw.description || ''),
    avatar: { color, initials: initials(name) },
    status: 'draft',
    request,
    goals: strs(raw.goals),
    rules: strs(raw.rules),
    responsibilities: strs(raw.responsibilities),
    instructions: String(raw.instructions || raw.systemInstructions || ''),
    scripts,
    entryScript: entry,
    triggers: normalizeTriggers(raw.triggers, entry, ids),
    permissions: {},
    browser: { enabled: false, domains: strs(raw.browser?.domains || raw.browserDomains).map((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) },
    collections: [],
    systems: [],
    metrics: arr(raw.metrics).map((m) => (typeof m === 'string' ? { key: slug(m), label: m } : { key: slug(m.key || m.label), label: String(m.label || m.key) })).filter((m) => m.key),
    escalation: { policy: String(raw.escalation?.policy || raw.escalation || ''), contact: String(raw.escalation?.contact || '') },
    reporting: { summary: String(raw.reporting?.summary || raw.reporting || '') },
    businessName: business?.name || '',
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
  employee.permissions = derivePermissions(employee, raw.permissions, preferences);
  employee.systems = usedSystems(employee);
  employee.browser.enabled = !!(employee.permissions.browser && Object.values(employee.permissions.browser).some((v) => v !== 'deny')) || !!preferences.browser;
  if (preferences.browser && !employee.permissions.browser) employee.permissions.browser = { read: 'allow', extract: 'allow', navigate: 'approval', click: 'approval', form_input: 'approval' };
  return employee;
}

export function normalizeTriggers(list, entry, ids) {
  const out = arr(list).map((t) => {
    const type = ['manual', 'schedule', 'browser'].includes(t.type) ? t.type : (t.schedule || t.cron || t.every ? 'schedule' : 'manual');
    const sched = t.schedule || {};
    const every = Number(sched.everyMinutes ?? sched.every_minutes ?? t.everyMinutes ?? 0) || 0;
    const dailyAt = /^\d{1,2}:\d{2}$/.test(sched.dailyAt || sched.daily_at || t.dailyAt || '') ? (sched.dailyAt || sched.daily_at || t.dailyAt) : '';
    const entryScript = ids.has(slug(t.entryScript || t.entry_script || '')) ? slug(t.entryScript || t.entry_script) : entry;
    return {
      id: uid('trg'),
      type: type === 'schedule' && !every && !dailyAt ? 'manual' : type,
      label: String(t.label || t.name || (type === 'schedule' ? 'Scheduled run' : 'Manual run')),
      description: String(t.description || ''),
      input: String(t.input || t.instruction || t.description || ''),
      entryScript,
      schedule: { everyMinutes: every ? Math.max(5, every) : 0, dailyAt },
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
    };
  });
  if (!out.some((t) => t.type === 'manual')) {
    out.unshift({ id: uid('trg'), type: 'manual', label: 'Manual run', description: 'Run on demand with an instruction.', input: '', entryScript: entry, schedule: { everyMinutes: 0, dailyAt: '' }, enabled: true, nextRunAt: null, lastRunAt: null });
  }
  return out;
}

// Least-privilege permissions derived from the tools the scripts actually use.
export function derivePermissions(employee, proposed = {}, preferences = {}) {
  const perms = {};
  for (const s of employee.scripts) {
    for (const name of s.tools) {
      const t = TOOL_MAP[name];
      const scopes = t.scopeFor ? ['read', 'write'] : [t.scope];
      perms[t.system] = perms[t.system] || {};
      for (const sc of scopes) perms[t.system][sc] = SENSITIVE_SCOPES.has(sc) ? 'approval' : 'allow';
    }
  }
  // AI proposals may only tighten (never loosen) the defaults.
  const prop = normalizePermissionInput(proposed);
  for (const [sys, scopes] of Object.entries(prop)) {
    if (!perms[sys]) continue;
    for (const [sc, lvl] of Object.entries(scopes)) {
      if (perms[sys][sc] === undefined) continue;
      if (lvl === 'deny' || (lvl === 'approval' && perms[sys][sc] === 'allow')) perms[sys][sc] = lvl;
    }
  }
  // User choices from the Create Employee form ("Send emails", "Access CRM data"…) can
  // adjust or revoke scopes the scripts need, but never grant systems they don't use.
  for (const [sys, scopes] of Object.entries(preferences.permissions || {})) {
    if (!perms[sys]) continue;
    for (const [sc, lvl] of Object.entries(scopes)) if (LEVELS.has(lvl) && perms[sys][sc] !== undefined) perms[sys][sc] = lvl;
  }
  return perms;
}

function normalizePermissionInput(p) {
  const out = {};
  if (Array.isArray(p)) {
    for (const e of p) {
      if (!e?.system || !SYSTEMS[e.system]) continue;
      out[e.system] = {};
      for (const [k, v] of Object.entries(e.scopes || {})) if (LEVELS.has(v)) out[e.system][k] = v;
    }
  } else if (p && typeof p === 'object') {
    for (const [sys, scopes] of Object.entries(p)) {
      if (!SYSTEMS[sys] || typeof scopes !== 'object') continue;
      out[sys] = {};
      for (const [k, v] of Object.entries(scopes)) if (LEVELS.has(v)) out[sys][k] = v;
    }
  }
  return out;
}

export function usedSystems(employee) {
  const set = new Set();
  for (const s of employee.scripts) for (const t of s.tools) set.add(TOOL_MAP[t].system);
  for (const [sys, scopes] of Object.entries(employee.permissions || {})) {
    if (Object.values(scopes).some((v) => v !== 'deny')) set.add(sys);
  }
  return [...set].filter((s) => SYSTEMS[s]);
}

/** Decide whether a tool call may run: 'allow' | 'approval' | 'deny'. */
export function evaluatePermission(employee, toolName, args = {}, { script, settings } = {}) {
  const tool = TOOL_MAP[toolName];
  if (!tool) return { level: 'deny', reason: `Unknown tool ${toolName}` };
  if (tool.internal) return { level: 'allow' };
  const scope = toolScope(tool, args);
  let level = employee.permissions?.[tool.system]?.[scope] || 'deny';
  if (level === 'deny') return { level, reason: `${employee.name} has no ${scope} permission for ${SYSTEMS[tool.system]?.name || tool.system}` };
  if (tool.system === 'files' && !(employee.collections || []).length) return { level: 'deny', reason: 'No knowledge collections are granted to this employee' };
  if (tool.system === 'browser' && !employee.browser?.enabled) return { level: 'deny', reason: 'Browser access is disabled for this employee' };
  const outbound = scope !== 'read' && scope !== 'extract';
  if (outbound && script?.approval?.required) level = 'approval';
  if (outbound && settings?.approveAllOutbound) level = 'approval';
  return { level, scope };
}

export function toolsForScript(employee, script) {
  const names = new Set(script ? script.tools : employee.scripts.flatMap((s) => s.tools));
  // Read-only knowledge tools are useful everywhere when granted.
  if ((employee.collections || []).length && employee.permissions?.files?.read && employee.permissions.files.read !== 'deny') {
    names.add('files_search');
    names.add('files_read');
  }
  return [...names].filter((n) => {
    const t = TOOL_MAP[n];
    if (!t) return false;
    if (t.scopeFor) return ['GET', 'POST'].some((m) => evaluatePermission(employee, n, { method: m }).level !== 'deny');
    return evaluatePermission(employee, n, {}).level !== 'deny';
  });
}

// ------------------------------------------------------------ Workflow graph
export function workflowLayout(employee) {
  const scripts = employee.scripts;
  const byId = Object.fromEntries(scripts.map((s) => [s.id, s]));
  // Classify back edges (loops) with a DFS so layering uses only forward edges.
  const back = new Set();
  const mark = {};
  const dfs = (id) => {
    mark[id] = 1;
    for (const n of byId[id].next) {
      if (!byId[n.script]) continue;
      if (mark[n.script] === 1) back.add(`${id}>${n.script}`);
      else if (!mark[n.script]) dfs(n.script);
    }
    mark[id] = 2;
  };
  if (byId[employee.entryScript]) dfs(employee.entryScript);
  for (const s of scripts) if (!mark[s.id]) dfs(s.id);
  const forward = (from) => byId[from].next.filter((n) => byId[n.script] && !back.has(`${from}>${n.script}`));
  const hasIncoming = new Set(scripts.flatMap((s) => forward(s.id).map((n) => n.script)));
  // Longest-path layering from the entry script and any other root.
  const depth = {};
  if (byId[employee.entryScript]) depth[employee.entryScript] = 0;
  for (const s of scripts) if (depth[s.id] === undefined && !hasIncoming.has(s.id)) depth[s.id] = 0;
  for (let i = 0; i < scripts.length; i++) {
    for (const s of scripts) {
      if (depth[s.id] === undefined) continue;
      for (const n of forward(s.id)) depth[n.script] = Math.max(depth[n.script] ?? -1, depth[s.id] + 1);
    }
  }
  let maxDepth = Math.max(0, ...Object.values(depth));
  for (const s of scripts) if (depth[s.id] === undefined) depth[s.id] = ++maxDepth;
  const layers = [];
  for (const s of scripts) (layers[depth[s.id]] = layers[depth[s.id]] || []).push(s.id);
  const edges = [];
  for (const s of scripts) for (const n of s.next) edges.push({ from: s.id, to: n.script, condition: n.condition, back: back.has(`${s.id}>${n.script}`) });
  return { layers: layers.filter(Boolean), edges, depth };
}

// ------------------------------------------------------------ Validation
export function validateEmployee(employee, { connections = {}, collections = [] } = {}) {
  const results = [];
  const add = (name, ok, detail = '', severity = ok ? 'pass' : 'fail') => results.push({ name, ok, detail, severity });
  const ids = new Set(employee.scripts.map((s) => s.id));

  add('Architecture has scripts', employee.scripts.length > 0, `${employee.scripts.length} script(s)`);
  add('Entry script defined', ids.has(employee.entryScript), employee.entryScript || 'missing');

  const badEdges = employee.scripts.flatMap((s) => s.next.filter((n) => !ids.has(n.script)).map((n) => `${s.id}→${n.script}`));
  add('All transitions resolve', badEdges.length === 0, badEdges.join(', ') || 'ok');

  const { depth } = workflowLayout(employee);
  const reach = new Set();
  const stack = [employee.entryScript];
  const byId = Object.fromEntries(employee.scripts.map((s) => [s.id, s]));
  while (stack.length) {
    const id = stack.pop();
    if (!byId[id] || reach.has(id)) continue;
    reach.add(id);
    byId[id].next.forEach((n) => stack.push(n.script));
    if (byId[id].failure.escalateTo) stack.push(byId[id].failure.escalateTo);
  }
  const unreachable = employee.scripts.filter((s) => !reach.has(s.id)).map((s) => s.name);
  results.push({ name: 'Scripts reachable from entry', ok: unreachable.length === 0, detail: unreachable.length ? `Only reachable via schedules/escalation: ${unreachable.join(', ')}` : 'all reachable', severity: unreachable.length ? 'warn' : 'pass' });
  void depth;

  // Cycles are allowed (e.g. follow-up loops) but are bounded by the runtime step limit.
  const cycles = [];
  const color = {};
  const visit = (id, path) => {
    color[id] = 1;
    for (const n of byId[id]?.next || []) {
      if (color[n.script] === 1) cycles.push([...path.slice(path.indexOf(n.script)), n.script].join(' → '));
      else if (!color[n.script]) visit(n.script, [...path, n.script]);
    }
    color[id] = 2;
  };
  employee.scripts.forEach((s) => { if (!color[s.id]) visit(s.id, [s.id]); });
  results.push({ name: 'Loops are bounded', ok: true, detail: cycles.length ? `Loop(s) ${cycles.slice(0, 2).join('; ')} — capped by the runtime step limit` : 'no loops', severity: cycles.length ? 'warn' : 'pass' });

  const unknownTools = employee.scripts.flatMap((s) => s.tools.filter((t) => !TOOL_MAP[t]));
  add('Tools exist in the tool registry', unknownTools.length === 0, unknownTools.join(', ') || `${new Set(employee.scripts.flatMap((s) => s.tools)).size} tool(s)`);

  const denied = [];
  for (const s of employee.scripts) for (const t of s.tools) {
    const r = evaluatePermission(employee, t, { method: 'GET' }, { script: s });
    if (r.level === 'deny') denied.push(`${t} (${s.name})`);
  }
  results.push({ name: 'Scripts have the permissions they need', ok: denied.length === 0, detail: denied.length ? `Blocked by permissions: ${denied.join(', ')}` : 'ok', severity: denied.length ? 'warn' : 'pass' });

  const missing = new Set();
  for (const sys of employee.systems) {
    const conn = SYSTEMS[sys]?.connection;
    if (conn && !(connections[conn]?.status === 'connected')) missing.add(CONNECTIONS[conn]?.name || conn);
  }
  results.push({ name: 'Required systems connected', ok: missing.size === 0, detail: missing.size ? `Connect: ${[...missing].join(', ')}` : 'all connected', severity: missing.size ? 'warn' : 'pass' });

  const sensitive = [];
  for (const [sys, scopes] of Object.entries(employee.permissions)) for (const [sc, lvl] of Object.entries(scopes)) if (SENSITIVE_SCOPES.has(sc) && lvl === 'allow') sensitive.push(`${sys}:${sc}`);
  results.push({ name: 'Outbound actions gated by approval', ok: sensitive.length === 0, detail: sensitive.length ? `Runs without approval: ${sensitive.join(', ')}` : 'all outbound actions require approval', severity: sensitive.length ? 'warn' : 'pass' });

  const noOutputs = employee.scripts.filter((s) => !s.outputs.length).map((s) => s.name);
  results.push({ name: 'Scripts declare structured outputs', ok: noOutputs.length === 0, detail: noOutputs.join(', ') || 'ok', severity: noOutputs.length ? 'warn' : 'pass' });

  add('Failure behavior defined', employee.scripts.every((s) => s.failure?.strategy), 'retry / escalate / skip / stop per script');
  add('Employee instructions configured', !!(employee.instructions || employee.rules.length || employee.goals.length), 'memory seeded');

  if (employee.permissions.files && !(employee.collections || []).length) {
    results.push({ name: 'Knowledge collections granted', ok: false, detail: collections.length ? 'Grant a collection in the Files tab' : 'Upload files in Files', severity: 'warn' });
  }

  const failed = results.filter((r) => r.severity === 'fail').length;
  const warnings = results.filter((r) => r.severity === 'warn').length;
  return { ranAt: now(), passed: failed === 0, failed, warnings, results };
}

export function scheduleNext(trigger, from = Date.now()) {
  if (trigger.type !== 'schedule' || !trigger.enabled) return null;
  if (trigger.schedule.everyMinutes) return from + trigger.schedule.everyMinutes * 60000;
  if (trigger.schedule.dailyAt) {
    const [h, m] = trigger.schedule.dailyAt.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}
