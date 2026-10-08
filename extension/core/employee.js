// Employee architecture: normalization of AI output, permission evaluation,
// workflow graph helpers and the validation suite run before deployment.
// Employees work inside systems (web apps) through the browser; permissions are
// per system and scope (read, navigate, click, form_input) plus knowledge files.
import { TOOL_MAP, SYSTEMS, SYSTEM_SCOPES, SCOPE_LABELS, SENSITIVE_SCOPES, DEFAULT_SCOPE_LEVELS, BROWSER_TOOLS, allSystems, systemForUrl, hostOf } from './catalog.js';
import { slug, uid, now } from './util.js';

const COLORS = ['#6366F1', '#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6'];
const LEVELS = new Set(['allow', 'approval', 'deny']);
const RANK = { allow: 0, approval: 1, deny: 2 };
const CUSTOM_ID = /^custom_[a-z0-9_-]+$/;
// Read-only browser tools a script needs to work in a system at all.
const BASE_BROWSER_TOOLS = ['browser_open', 'browser_read_page', 'browser_extract', 'browser_scroll', 'browser_wait', 'browser_navigate'];

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

/** Connections as rows (accepts the store's array or an id → row map). */
export function connectionRows(connections) {
  if (Array.isArray(connections)) return connections.filter(Boolean);
  return connections && typeof connections === 'object' ? Object.values(connections).filter((c) => c && typeof c === 'object') : [];
}

/**
 * Whether an id names a system. With connections, custom web apps must exist;
 * without them, well-formed custom ids are kept so they are not silently dropped.
 */
export function isSystemId(id, connections) {
  if (typeof id !== 'string' || !id) return false;
  if (SYSTEMS[id]) return true;
  if (connections === undefined || connections === null) return CUSTOM_ID.test(id);
  return !!allSystems(connectionRows(connections))[id];
}

/** Normalize a website domain from user/AI input ("https://www.x.com/a" → "www.x.com"). */
export function cleanDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
}

export function normalizeScript(s, idx, usedIds, connections) {
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
    systems: [...new Set(arr(s.systems || s.system).map((x) => String(typeof x === 'object' && x ? x.id || '' : x).trim()).filter((x) => isSystemId(x, connections)))],
    tools: [...new Set(arr(s.tools).map(String).filter((t) => TOOL_MAP[t] && TOOL_MAP[t].system !== 'internal'))],
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

export function normalizeEmployee(raw, { request = '', business = {}, preferences = {}, connections = [] } = {}) {
  void business; // the business profile is stored as memory by the generator, never on the employee
  const conns = connectionRows(connections);
  const used = new Set();
  const scripts = arr(raw.scripts).map((s, i) => normalizeScript(s, i, used, conns));
  const ids = new Set(scripts.map((s) => s.id));
  for (const s of scripts) {
    s.next = s.next.filter((n) => n.script === 'end' || ids.has(n.script)).map((n) => (n.script === 'end' ? null : n)).filter(Boolean);
    s.dependencies = s.dependencies.filter((d) => ids.has(d));
    if (s.failure.escalateTo && !ids.has(s.failure.escalateTo)) s.failure.escalateTo = '';
    // A script that works in a system cannot do anything without at least the read-only browser tools.
    if (s.systems.length && !s.tools.some((t) => BROWSER_TOOLS.includes(t))) s.tools.push(...BASE_BROWSER_TOOLS);
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
    browser: { domains: [] },
    collections: [],
    systems: [],
    metrics: arr(raw.metrics).map((m) => (typeof m === 'string' ? { key: slug(m), label: m } : { key: slug(m.key || m.label), label: String(m.label || m.key) })).filter((m) => m.key),
    escalation: { policy: String(raw.escalation?.policy || raw.escalation || ''), contact: String(raw.escalation?.contact || '') },
    reporting: { summary: String(raw.reporting?.summary || raw.reporting || '') },
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
  // "Other websites" must not be systems — those are governed by system permissions.
  employee.browser.domains = [...new Set(strs(raw.browser?.domains || raw.browserDomains || raw.web_domains).map(cleanDomain)
    .filter((d) => d && d.includes('.') && !systemForUrl(`https://${d}/`, conns)))];
  employee.permissions = derivePermissions(employee, raw.permissions, preferences);
  employee.systems = usedSystems(employee);
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


// ------------------------------------------------------------ Permissions
/**
 * Least-privilege permissions: every system a script works in gets
 * DEFAULT_SCOPE_LEVELS; knowledge files get read when a script uses file tools.
 * AI proposals may only tighten these. Owner preferences (the Create form) may
 * adjust scopes of systems already present, but never add systems.
 */
export function derivePermissions(employee, proposed = {}, preferences = {}) {
  const perms = {};
  for (const s of employee.scripts) {
    for (const id of s.systems || []) if (!perms[id]) perms[id] = { ...DEFAULT_SCOPE_LEVELS };
    if ((s.tools || []).some((t) => TOOL_MAP[t]?.system === 'files')) perms.files = { read: 'allow' };
  }
  for (const [sys, scopes] of Object.entries(normalizePermissionInput(proposed))) {
    if (!perms[sys]) continue;
    for (const [sc, lvl] of Object.entries(scopes)) {
      if (perms[sys][sc] !== undefined && RANK[lvl] > RANK[perms[sys][sc]]) perms[sys][sc] = lvl;
    }
  }
  for (const [sys, scopes] of Object.entries(normalizePermissionInput(preferences?.permissions))) {
    if (!perms[sys]) continue;
    for (const [sc, lvl] of Object.entries(scopes)) if (perms[sys][sc] !== undefined) perms[sys][sc] = lvl;
  }
  return perms;
}

// Accepts {sys: {scope: level}}, {sys: level} or [{system, scopes}] and keeps valid entries.
function normalizePermissionInput(p) {
  const out = {};
  const put = (sys, scopes) => {
    if (typeof sys !== 'string' || !sys) return;
    const valid = sys === 'files' ? ['read'] : SYSTEM_SCOPES;
    const entry = {};
    if (typeof scopes === 'string') { if (LEVELS.has(scopes)) for (const sc of valid) entry[sc] = scopes; }
    else if (scopes && typeof scopes === 'object') for (const [k, v] of Object.entries(scopes)) if (valid.includes(k) && LEVELS.has(v)) entry[k] = v;
    if (Object.keys(entry).length) out[sys] = { ...(out[sys] || {}), ...entry };
  };
  if (Array.isArray(p)) for (const e of p) put(e?.system, e?.scopes ?? e?.level);
  else if (p && typeof p === 'object') for (const [sys, scopes] of Object.entries(p)) put(sys, scopes);
  return out;
}

/** System ids (not 'files') the employee may use: any scope that is not deny. */
export function usedSystems(employee) {
  return Object.entries(employee.permissions || {})
    .filter(([id, scopes]) => id !== 'files' && isSystemId(id) && scopes && typeof scopes === 'object'
      && SYSTEM_SCOPES.some((sc) => LEVELS.has(scopes[sc]) && scopes[sc] !== 'deny'))
    .map(([id]) => id);
}

function domainAllowed(host, domains = []) {
  const h = String(host || '').toLowerCase();
  return !!h && domains.map(cleanDomain).some((d) => d && (h === d || h.endsWith(`.${d}`)));
}

/**
 * Decide whether a tool call may run.
 * @returns {{level:'allow'|'approval'|'deny', reason?:string, system?:string|null, scope?:string}}
 */
export function evaluatePermission(employee, toolName, args = {}, { script, settings, url, connections } = {}) {
  const tool = TOOL_MAP[toolName];
  if (!tool) return { level: 'deny', reason: `Unknown tool ${toolName}` };
  if (tool.system === 'internal') return { level: 'allow' };
  const who = employee?.name || 'This employee';
  const perms = employee?.permissions || {};

  if (tool.system === 'files') {
    const lvl = LEVELS.has(perms.files?.read) ? perms.files.read : 'deny';
    if (lvl === 'deny') return { level: 'deny', reason: `${who} has no permission to read knowledge files`, system: 'files', scope: 'read' };
    if (!(employee.collections || []).length) return { level: 'deny', reason: 'No knowledge collections are granted to this employee', system: 'files', scope: 'read' };
    return { level: lvl, system: 'files', scope: 'read' };
  }

  const conns = connectionRows(connections);
  const systems = allSystems(conns);
  const domains = employee?.browser?.domains || [];
  const scope = tool.scope;
  let system;
  if (toolName === 'browser_open') {
    system = String(args?.system || '');
    if (!system) return { level: 'deny', reason: 'browser_open needs a system id', scope };
  } else if (toolName === 'browser_navigate') {
    system = systemForUrl(args?.url, conns);
    if (!system) {
      const host = hostOf(args?.url);
      if (domainAllowed(host, domains)) return { level: 'allow', system: null, scope };
      return { level: 'deny', reason: `${host || args?.url || 'That URL'} is not in one of ${who}'s systems or allowed websites`, system: null, scope };
    }
  } else {
    if (!url) return { level: 'deny', reason: 'No working tab — call browser_open first', system: null, scope };
    system = systemForUrl(url, conns);
    if (!system) {
      const host = hostOf(url);
      if (domainAllowed(host, domains)) {
        if (scope === 'read') return { level: 'allow', system: null, scope };
        return { level: 'deny', reason: `${host} is an allowed website for reading and navigating only — clicking and typing there are not permitted`, system: null, scope };
      }
      return { level: 'deny', reason: `The working tab (${host || url}) is not in one of ${who}'s systems. If it is a sign-in or error page, use request_human_help; otherwise use browser_open to return to a system`, system: null, scope };
    }
  }

  let level = perms[system]?.[scope];
  if (!LEVELS.has(level)) level = 'deny';
  if (level === 'deny') {
    return { level, reason: `${who} has no ${SCOPE_LABELS[scope] || scope} permission for ${systems[system]?.name || system}`, system, scope };
  }
  if (SENSITIVE_SCOPES.has(scope) && level === 'allow' && (script?.approval?.required || settings?.approveAllOutbound)) level = 'approval';
  return { level, system, scope };
}

/** Whether a tool can ever run for this employee (ignores the current tab). */
function toolUsable(employee, name) {
  const t = TOOL_MAP[name];
  if (!t) return false;
  if (t.system === 'internal') return true;
  const perms = employee.permissions || {};
  if (t.system === 'files') return LEVELS.has(perms.files?.read) && perms.files.read !== 'deny' && (employee.collections || []).length > 0;
  const systems = usedSystems(employee);
  if (!systems.length) return false;
  if (systems.some((id) => LEVELS.has(perms[id]?.[t.scope]) && perms[id][t.scope] !== 'deny')) return true;
  // Other websites allow reading/navigating once a system tab is open.
  return (t.scope === 'read' || t.scope === 'navigate') && name !== 'browser_open' && (employee.browser?.domains || []).length > 0;
}

/** Catalog tools offered to a script: its listed tools that are not denied outright. */
export function toolsForScript(employee, script) {
  const names = new Set(script ? script.tools : employee.scripts.flatMap((s) => s.tools));
  // Read-only knowledge tools are useful everywhere when granted.
  if (toolUsable(employee, 'files_search')) { names.add('files_search'); names.add('files_read'); }
  return [...names].filter((n) => TOOL_MAP[n] && TOOL_MAP[n].system !== 'internal' && toolUsable(employee, n));
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
/**
 * @param {object} employee
 * @param {{connections?: Array<object>, collections?: Array<object>}} [opts] connections = rows of the `connections` store
 */
export function validateEmployee(employee, { connections = [], collections = [] } = {}) {
  const conns = connectionRows(connections);
  const systems = allSystems(conns);
  const sysName = (id) => systems[id]?.name || id;
  const results = [];
  const add = (name, ok, detail = '', severity = ok ? 'pass' : 'fail') => results.push({ name, ok, detail, severity });
  const ids = new Set(employee.scripts.map((s) => s.id));

  add('Architecture has scripts', employee.scripts.length > 0, `${employee.scripts.length} script(s)`);
  add('Entry script defined', ids.has(employee.entryScript), employee.entryScript || 'missing');

  const badEdges = employee.scripts.flatMap((s) => s.next.filter((n) => !ids.has(n.script)).map((n) => `${s.id}→${n.script}`));
  add('All transitions resolve', badEdges.length === 0, badEdges.join(', ') || 'ok');

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
  for (const s of employee.scripts) {
    const offered = new Set(toolsForScript(employee, s));
    for (const t of s.tools) if (TOOL_MAP[t] && !offered.has(t)) denied.push(`${t} (${s.name})`);
    for (const sys of s.systems || []) {
      const scopes = employee.permissions?.[sys];
      if (!scopes || !SYSTEM_SCOPES.some((sc) => scopes[sc] && scopes[sc] !== 'deny')) denied.push(`${sysName(sys)} (${s.name})`);
    }
  }
  results.push({ name: 'Scripts have the permissions they need', ok: denied.length === 0, detail: denied.length ? `Blocked by permissions: ${denied.join(', ')}` : 'ok', severity: denied.length ? 'warn' : 'pass' });

  const blind = employee.scripts.filter((s) => (s.systems || []).length && !s.tools.includes('browser_open')).map((s) => s.name);
  results.push({ name: 'Scripts can open their systems', ok: blind.length === 0, detail: blind.length ? `No browser_open: ${blind.join(', ')}` : 'ok', severity: blind.length ? 'warn' : 'pass' });

  const missing = [];
  for (const id of usedSystems(employee)) {
    const row = conns.find((c) => c.id === id);
    if (!row) missing.push(sysName(id));
    else if ((SYSTEMS[id]?.address || row.custom) && !row.url) missing.push(`${sysName(id)} (address needed)`);
  }
  results.push({ name: 'Systems connected', ok: missing.length === 0, detail: missing.length ? `Connect in Systems: ${missing.join(', ')}` : (usedSystems(employee).length ? 'all connected' : 'no systems used'), severity: missing.length ? 'warn' : 'pass' });

  const sensitive = [];
  for (const [sys, scopes] of Object.entries(employee.permissions || {})) {
    if (sys === 'files' || !scopes || typeof scopes !== 'object') continue;
    for (const [sc, lvl] of Object.entries(scopes)) if (SENSITIVE_SCOPES.has(sc) && lvl === 'allow') sensitive.push(`${sysName(sys)} ${SCOPE_LABELS[sc] || sc}`);
  }
  results.push({ name: 'Actions in systems gated by approval', ok: sensitive.length === 0, detail: sensitive.length ? `Runs without approval: ${sensitive.join(', ')}` : 'clicking and typing in systems require approval', severity: sensitive.length ? 'warn' : 'pass' });

  const noOutputs = employee.scripts.filter((s) => !s.outputs.length).map((s) => s.name);
  results.push({ name: 'Scripts declare structured outputs', ok: noOutputs.length === 0, detail: noOutputs.join(', ') || 'ok', severity: noOutputs.length ? 'warn' : 'pass' });

  add('Failure behavior defined', employee.scripts.every((s) => s.failure?.strategy), 'retry / escalate / skip / stop per script');
  add('Employee instructions configured', !!(employee.instructions || employee.rules.length || employee.goals.length), 'memory seeded');

  if (employee.permissions?.files && !(employee.collections || []).length) {
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
