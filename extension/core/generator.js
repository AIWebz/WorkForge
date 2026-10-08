// Employee generation pipeline. Each stage reports real progress; stages that
// need reasoning call the AI engine, the rest compile and validate locally.
import { chatJSON } from './ai.js';
import { catalogForPrompt, SYSTEMS } from './catalog.js';
import { normalizeEmployee, validateEmployee, workflowLayout } from './employee.js';
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
Always answer with a single JSON object and nothing else.`;

function businessBlock(business) {
  if (!business) return 'Not provided.';
  return [
    business.name && `Company: ${business.name}`,
    business.description && `What the business does: ${business.description}`,
    business.automate && `Work they want automated: ${business.automate}`,
    business.systems?.length && `Systems they use: ${business.systems.join(', ')}`,
  ].filter(Boolean).join('\n') || 'Not provided.';
}

export async function analyzeRequest(ai, { request, business, form }) {
  const prompt = `Analyze this request for a new AI employee.

<business>
${businessBlock(business)}
</business>

<request>
${request}
</request>
${form?.name ? `Requested employee name: ${form.name}\n` : ''}${form?.role ? `Requested role: ${form.role}\n` : ''}${form?.systems?.length ? `Systems selected by the user: ${form.systems.join(', ')}\n` : ''}
Return JSON:
{
  "name": "short human first name for the employee (use the requested name if given)",
  "role": "job title",
  "summary": "one sentence describing what this employee does",
  "responsibilities": ["concrete responsibilities"],
  "goals": ["measurable goals"],
  "workflow_outline": ["ordered high-level steps, including decision points and branches"],
  "systems_needed": ["system ids from: ${Object.keys(SYSTEMS).join(', ')}"],
  "human_approval_points": ["actions that must be approved by a human"],
  "risks": ["what could go wrong"],
  "metrics": [{"key": "snake_case", "label": "Human label"}],
  "triggers": ["when this employee should run (on demand, every N minutes, daily at HH:MM, inside a browser tab)"]
}`;
  const { data } = await chatJSON(ai, { system: ENGINE_SYSTEM, prompt, maxTokens: 6000 });
  return data;
}

export async function designArchitecture(ai, { request, business, analysis, form }) {
  const prompt = `Design the complete architecture for this AI employee. The number and kind of scripts must follow from the work described — do not use a fixed template. Typical employees have 4–14 scripts.

<business>
${businessBlock(business)}
</business>

<request>
${request}
</request>

<analysis>
${JSON.stringify(analysis, null, 1)}
</analysis>

<tool_catalog>
${catalogForPrompt()}
</tool_catalog>
Every script automatically also has: memory_search, memory_save, record_metric, request_human_help (escalation), schedule_followup, notify_user. List only catalog tools in "tools".
${form?.browser ? 'The user wants this employee to work inside browser tabs via the extension: include browser_* tools where useful.\n' : ''}
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
      "instructions": "step-by-step instructions the AI follows when executing this script",
      "trigger": "when it runs",
      "inputs": [{"name": "…", "type": "string|number|boolean|object|array", "description": "…"}],
      "outputs": [{"name": "…", "type": "…", "description": "…"}],
      "conditions": ["preconditions / decision criteria"],
      "tools": ["catalog tool names"],
      "dependencies": ["script ids whose outputs it needs"],
      "next": [{"script": "script_id", "condition": "when to go there"}],
      "failure": {"strategy": "retry|escalate|skip|stop", "maxRetries": 1, "escalateTo": "script id or empty", "notes": "…"},
      "approval": {"required": false, "reason": "why a human must approve (only for risky outbound actions)"},
      "estimatedMinutes": "minutes a human would spend doing this step manually (number)"
    }
  ],
  "triggers": [{"type": "manual|schedule|browser", "label": "…", "description": "…", "input": "instruction the employee receives when triggered", "entryScript": "script id", "schedule": {"everyMinutes": 0, "dailyAt": "HH:MM or empty"}}],
  "permissions": {"system_id": {"scope": "allow|approval|deny"}},
  "browser": {"domains": ["domains the employee may work on, if any"]},
  "metrics": [{"key": "snake_case", "label": "…"}],
  "escalation": {"policy": "when and how to involve a human"},
  "reporting": "what the employee reports and how often"
}`;
  const { data } = await chatJSON(ai, { system: ENGINE_SYSTEM, prompt, maxTokens: 16000 });
  return data;
}

/**
 * Run the full pipeline.
 * @param {object} opts
 * @param {(stageId:string, status:'running'|'done'|'error', detail?:string)=>void} opts.onStage
 */
export async function generateEmployee({ db, ai, request, business, form = {}, connections = {}, collections = [], onStage = () => {} }) {
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

  const analysis = await stage('analyze', () => analyzeRequest(ai, { request, business, form }));
  const raw = await stage('architecture', () => designArchitecture(ai, { request, business, analysis, form }));

  let employee;
  await stage('scripts', async () => {
    employee = normalizeEmployee(raw, { request, business, preferences: form });
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
    const biz = businessBlock(business);
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
    employee.tests = validateEmployee(employee, { connections, collections });
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
  await addMemory(db, employee.id, 'system', `Connected systems at creation: ${employee.systems.map((s) => SYSTEMS[s]?.name || s).join(', ') || 'none'}`, { source: 'generation' });
  return employee;
}
