// Employee generation pipeline. Each stage reports real progress; stages that
// need reasoning call the AI engine, the rest compile and validate locally.
import { chatJSON } from './ai.js';
import { catalogForPrompt, allSystems, SYSTEM_SCOPES, TOOLS } from './catalog.js';
import { normalizeEmployee, validateEmployee, workflowLayout, connectionRows } from './employee.js';
import { addMemory } from './memory.js';

export const GENERATION_STAGES = [
  { id: 'analyze', label: 'Analyzing employee requirements' },
  { id: 'architecture', label: 'Designing employee architecture' },
  { id: 'scripts', label: 'Generating scripts' },
  { id: 'logic', label: 'Creating decision logic' },
  { id: 'memory', label: 'Configuring memory' },
  { id: 'permissions', label: 'Configuring permissions' },
  { id: 'tools', label: 'Connecting tools' },
  { id: 'testing', label: 'Testing employee' },
];

const ENGINE_SYSTEM = `You are the WorkForge AI engine. WorkForge turns a business's description of the work it needs into a complete, executable AI employee: a set of scripts that the WorkForge runtime executes one at a time, using tools, under permissions and human approvals.
There are NO APIs or integrations. Employees do their work inside the business's systems — ordinary web apps such as Gmail or HubSpot — by operating each app's web interface in a browser tab through the WorkForge browser extension, using the owner's own signed-in session (open the app, read the page, click, type, navigate). They also have their own memory and the owner's knowledge files.
Always answer with a single JSON object and nothing else.`;

const BROWSER_HOW = `How employees work: there are no APIs. In a system the employee calls browser_open (system id), then browser_read_page to see the page text and interactive elements (ref ids), then browser_click / browser_fill with those refs, browser_navigate between pages, browser_scroll / browser_extract to read more, browser_wait while loading. Clicking and typing (form_input) in a system are actions that change things; reading and navigating are not. Employees never type passwords and ask a human (request_human_help) when signed out or blocked.`;

function systemNames(ids, connections) {
  const all = allSystems(connections);
  return (ids || []).map((id) => (all[id] ? `${all[id].name} (${id})` : id));
}

function businessBlock(business, connections = []) {
  if (!business) return 'Not provided.';
  return [
    business.description && `What the business does: ${business.description}`,
    business.automate && `Work they want automated: ${business.automate}`,
    business.systems?.length && `Systems they use: ${systemNames(business.systems, connections).join(', ')}`,
  ].filter(Boolean).join('\n') || 'Not provided.';
}

function connectedBlock(connections) {
  const all = allSystems(connections);
  const rows = connections.filter((c) => all[c.id]);
  return rows.length ? rows.map((c) => `- ${c.id}: ${all[c.id].name}${c.url ? ` — ${c.url}` : ''}`).join('\n') : 'None connected yet.';
}

export async function analyzeRequest(ai, { request, business, form, connections = [] }) {
  const conns = connectionRows(connections);
  const prompt = `Analyze this request for a new AI employee.

${BROWSER_HOW}

<business>
${businessBlock(business, conns)}
</business>

<connected_systems>
${connectedBlock(conns)}
</connected_systems>

<request>
${request}
</request>
${form?.name ? `Requested employee name: ${form.name}\n` : ''}${form?.role ? `Requested role: ${form.role}\n` : ''}${form?.systems?.length ? `Systems selected by the owner for this employee: ${systemNames(form.systems, conns).join(', ')}\n` : ''}
Return JSON:
{
  "name": "short human first name for the employee (use the requested name if given)",
  "role": "job title",
  "summary": "one sentence describing what this employee does",
  "responsibilities": ["concrete responsibilities"],
  "goals": ["measurable goals"],
  "workflow_outline": ["ordered high-level steps (what the employee does in which system's web interface), including decision points and branches"],
  "systems_needed": ["system ids from: ${Object.keys(allSystems(conns)).join(', ')} — only the web apps the work really needs; prefer connected and owner-selected systems"],
  "human_approval_points": ["actions that must be approved by a human (e.g. sending an email, updating a record)"],
  "risks": ["what could go wrong"],
  "metrics": [{"key": "snake_case", "label": "Human label"}],
  "triggers": ["when this employee should run (on demand, every N minutes, daily at HH:MM, inside a browser tab)"]
}`;
  const { data } = await chatJSON(ai, { system: ENGINE_SYSTEM, prompt, schema: analysisSchema(Object.keys(allSystems(conns))), maxTokens: 1500 });
  return data;
}

// JSON schema for the requirements analysis (enforced by constrained decoding).
function analysisSchema(systemIds) {
  const str = { type: 'string' };
  const strs = { type: 'array', items: str };
  const properties = {
    name: str, role: str, summary: str, responsibilities: strs, goals: strs, workflow_outline: strs,
    systems_needed: { type: 'array', items: { type: 'string', enum: systemIds } },
    human_approval_points: strs, risks: strs,
    metrics: { type: 'array', items: { type: 'object', properties: { key: str, label: str }, required: ['key', 'label'] } },
    triggers: strs,
  };
  return { type: 'object', properties, required: Object.keys(properties) };
}

// JSON schema the engine's constrained decoding enforces for the architecture,
// so even small local models return a structurally valid employee. Constrained
// decoding allows only these keys, in this order, so it mirrors the prompt's template.
function architectureSchema(systemIds) {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const strs = { type: 'array', items: str };
  const level = { type: 'string', enum: ['allow', 'approval', 'deny'] };
  const field = { type: 'object', properties: { name: str, type: str, description: str }, required: ['name', 'type', 'description'] };
  // Internal tools are allowed here (normalizeScript drops them; every script gets them anyway) so the
  // grammar never forces a model that lists one into a different, more powerful tool.
  const toolNames = TOOLS.map((t) => t.name);
  return {
    type: 'object',
    properties: {
      name: str, role: str, summary: str, instructions: str, goals: strs, rules: strs, entryScript: str,
      scripts: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            id: str, name: str, description: str, purpose: str, instructions: str, trigger: str,
            inputs: { type: 'array', items: field }, outputs: { type: 'array', items: field },
            conditions: strs,
            systems: { type: 'array', items: { type: 'string', enum: systemIds } },
            tools: { type: 'array', items: { type: 'string', enum: toolNames } },
            dependencies: strs,
            next: { type: 'array', items: { type: 'object', properties: { script: str, condition: str }, required: ['script', 'condition'] } },
            failure: { type: 'object', properties: { strategy: { type: 'string', enum: ['retry', 'escalate', 'skip', 'stop'] }, maxRetries: int, escalateTo: str, notes: str }, required: ['strategy', 'maxRetries', 'escalateTo'] },
            approval: { type: 'object', properties: { required: { type: 'boolean' }, reason: str }, required: ['required', 'reason'] },
            estimatedMinutes: int,
          },
          required: ['id', 'name', 'description', 'purpose', 'instructions', 'outputs', 'systems', 'tools', 'next', 'failure', 'approval', 'estimatedMinutes'],
        },
      },
      triggers: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['manual', 'schedule', 'browser'] }, label: str, description: str, input: str, entryScript: str, schedule: { type: 'object', properties: { everyMinutes: int, dailyAt: str }, required: ['everyMinutes', 'dailyAt'] } }, required: ['type', 'label', 'input', 'entryScript', 'schedule'] } },
      permissions: { type: 'object', additionalProperties: { type: 'object', properties: Object.fromEntries(SYSTEM_SCOPES.map((sc) => [sc, level])) } },
      browser: { type: 'object', properties: { domains: strs }, required: ['domains'] },
      metrics: { type: 'array', items: { type: 'object', properties: { key: str, label: str }, required: ['key', 'label'] } },
      escalation: { type: 'object', properties: { policy: str }, required: ['policy'] },
      reporting: str,
    },
    required: ['name', 'role', 'summary', 'instructions', 'goals', 'rules', 'entryScript', 'scripts', 'triggers', 'metrics', 'escalation', 'reporting'],
  };
}

export async function designArchitecture(ai, { request, business, analysis, form, connections = [] }) {
  const conns = connectionRows(connections);
  const prompt = `Design the complete architecture for this AI employee. The number and kind of scripts must follow from the work described — do not use a fixed template. Typical employees have 3–10 scripts (never more than 10); keep each script's text concise.

${BROWSER_HOW}

<business>
${businessBlock(business, conns)}
</business>

<connected_systems>
${connectedBlock(conns)}
</connected_systems>
${form?.systems?.length ? `Systems selected by the owner for this employee: ${systemNames(form.systems, conns).join(', ')}\n` : ''}
<request>
${request}
</request>

<analysis>
${JSON.stringify(analysis, null, 1)}
</analysis>

<catalog>
${catalogForPrompt(conns)}
</catalog>
Every script automatically also has: memory_search, memory_save, record_metric, request_human_help (escalation), schedule_followup, notify_user. In each script list "systems" (system ids from the catalog that the script works in) and "tools" (only catalog tool names). A script that works in a system needs at least browser_open and browser_read_page; add browser_click / browser_fill only where the script must change something. Use only systems the work needs — permissions are granted per system, least privilege.
Script "instructions" must be concrete steps in each system's web interface (e.g. "browser_open gmail; search for is:unread label:leads; open each thread; read the sender and request; …"), including what to verify on the page after each action and when to ask a human.

Each script is executed by the AI engine with only its listed tools. When a script finishes, the engine chooses the next script from its "next" list (or END) based on the conditions, so encode the decision logic in "next" conditions. Include error handling and human escalation scripts when the work warrants them.

Return JSON:
{
  "name": "${analysis.name || 'Alex'}",
  "role": "${analysis.role || ''}",
  "summary": "…",
  "instructions": "standing instructions / persona for the employee (tone, priorities, policies)",
  "goals": ["…"],
  "rules": ["hard rules the employee must always follow"],
  "entryScript": "id of the first script",
  "scripts": [
    {
      "id": "snake_case_id",
      "name": "Human Name Script",
      "description": "what it does",
      "purpose": "why it exists",
      "instructions": "step-by-step UI instructions the AI follows when executing this script",
      "trigger": "when it runs",
      "inputs": [{"name": "…", "type": "string|number|boolean|object|array", "description": "…"}],
      "outputs": [{"name": "…", "type": "…", "description": "…"}],
      "conditions": ["preconditions / decision criteria"],
      "systems": ["system ids this script works in"],
      "tools": ["catalog tool names (browser_*, files_*)"],
      "dependencies": ["script ids whose outputs it needs"],
      "next": [{"script": "script_id", "condition": "when to go there"}],
      "failure": {"strategy": "retry|escalate|skip|stop", "maxRetries": 1, "escalateTo": "script id or empty", "notes": "…"},
      "approval": {"required": false, "reason": "set true when every click/type in this script must be approved (e.g. sending money); clicking and typing already require approval by default"},
      "estimatedMinutes": "minutes a human would spend doing this step manually (number)"
    }
  ],
  "triggers": [{"type": "manual|schedule|browser", "label": "…", "description": "…", "input": "instruction the employee receives when triggered", "entryScript": "script id", "schedule": {"everyMinutes": 0, "dailyAt": "HH:MM or empty"}}],
  "permissions": {"system_id": {"${SYSTEM_SCOPES.join('|')}": "allow|approval|deny"}},
  "browser": {"domains": ["other public websites (not systems) the employee may read for research, if any — e.g. a supplier's site"]},
  "metrics": [{"key": "snake_case", "label": "…"}],
  "escalation": {"policy": "when and how to involve a human"},
  "reporting": "what the employee reports and how often"
}`;
  const { data } = await chatJSON(ai, { system: ENGINE_SYSTEM, prompt, schema: architectureSchema(Object.keys(allSystems(conns))), maxTokens: 8000 });
  return data;
}

/**
 * Run the full pipeline.
 * @param {object} opts
 * @param {(stageId:string, status:'running'|'done'|'error', detail?:string)=>void} opts.onStage
 */
export async function generateEmployee({ db, ai, request, business, form = {}, connections = [], collections = [], onStage = () => {} }) {
  const conns = connectionRows(connections);
  const stage = async (id, fn) => {
    onStage(id, 'running');
    try {
      const out = await fn();
      onStage(id, 'done', typeof out === 'string' ? out : undefined);
      return out;
    } catch (e) {
      onStage(id, 'error', e.message);
      throw e;
    }
  };

  const analysis = await stage('analyze', () => analyzeRequest(ai, { request, business, form, connections: conns }));
  const raw = await stage('architecture', () => designArchitecture(ai, { request, business, analysis, form, connections: conns }));

  let employee;
  await stage('scripts', async () => {
    employee = normalizeEmployee(raw, { request, business, preferences: form, connections: conns });
    if (form.name) { employee.name = form.name; employee.avatar.initials = form.name.slice(0, 2).toUpperCase(); }
    if (form.role) employee.role = form.role;
    if (!employee.scripts.length) throw new Error('The AI engine returned no scripts. Try describing the work in more detail.');
    employee.analysis = analysis;
    if (!employee.metrics.length && Array.isArray(analysis.metrics)) {
      employee.metrics = analysis.metrics.filter((m) => m?.key).map((m) => ({ key: String(m.key), label: String(m.label || m.key) }));
    }
    return `${employee.scripts.length} scripts`;
  });

  await stage('logic', async () => {
    const { edges } = workflowLayout(employee);
    return `${edges.length} transitions`;
  });

  await stage('memory', async () => {
    const seeds = [];
    if (employee.instructions) seeds.push(['instructions', employee.instructions]);
    for (const r of employee.rules) seeds.push(['instructions', `Rule: ${r}`]);
    for (const g of employee.goals) seeds.push(['instructions', `Goal: ${g}`]);
    const biz = businessBlock(business, conns);
    if (biz !== 'Not provided.') seeds.push(['business', biz]);
    if (employee.escalation.policy) seeds.push(['instructions', `Escalation policy: ${employee.escalation.policy}`]);
    if (employee.reporting.summary) seeds.push(['instructions', `Reporting: ${employee.reporting.summary}`]);
    employee._memorySeeds = seeds;
    return `${seeds.length} memory items`;
  });

  await stage('permissions', async () => {
    if (form.collections?.length) {
      employee.collections = form.collections.filter((c) => collections.some((x) => x.id === c));
      if (employee.collections.length) employee.permissions.files = { read: 'allow' };
    }
    const count = Object.values(employee.permissions).reduce((a, s) => a + Object.keys(s).length, 0);
    return `${count} scoped permissions`;
  });

  await stage('tools', async () => {
    const tools = new Set(employee.scripts.flatMap((s) => s.tools));
    return `${tools.size} tools across ${employee.systems.length} systems`;
  });

  await stage('testing', async () => {
    employee.tests = validateEmployee(employee, { connections: conns, collections });
    if (!employee.tests.passed) {
      const fails = employee.tests.results.filter((r) => r.severity === 'fail').map((r) => `${r.name}: ${r.detail}`);
      throw new Error(`Validation failed — ${fails.join('; ')}`);
    }
    return `${employee.tests.results.length} checks, ${employee.tests.warnings} warning(s)`;
  });

  // Persist the employee and its memory.
  const seeds = employee._memorySeeds || [];
  delete employee._memorySeeds;
  await db.put('employees', employee);
  for (const [kind, content] of seeds) await addMemory(db, employee.id, kind, content, { source: 'generation' });
  const all = allSystems(conns);
  await addMemory(db, employee.id, 'system', `Systems at creation (operated through the browser with the owner's login): ${employee.systems.map((s) => all[s]?.name || s).join(', ') || 'none'}`, { source: 'generation' });
  return employee;
}
