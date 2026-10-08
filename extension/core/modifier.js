// Natural-language control of an employee. The AI engine translates an
// instruction into structured operations that are applied to the stored
// employee architecture (with versioning so every change can be undone).
import { chatJSON } from './ai.js';
import { TOOL_MAP, SYSTEMS, catalogForPrompt } from './catalog.js';
import { normalizeScript, usedSystems, validateEmployee, normalizeTriggers, scheduleNext } from './employee.js';
import { addMemory } from './memory.js';
import { clone, slug, uid, now, truncate } from './util.js';

const OPS_DOC = `Supported operations (JSON objects in "operations"):
- {"op":"update_profile","changes":{"name"?,"role"?,"summary"?,"instructions"?}}
- {"op":"add_rule","rule":"…"} | {"op":"remove_rule","text":"rule text to remove"}
- {"op":"add_goal","goal":"…"}
- {"op":"add_script","script":{id,name,description,purpose,instructions,inputs,outputs,conditions,tools,next:[{script,condition}],failure,approval,estimatedMinutes},"after":"existing script id or empty","condition":"condition for the edge from 'after'","replace_edges":false}
- {"op":"update_script","id":"script id","changes":{any script fields}}
- {"op":"remove_script","id":"script id"}  (predecessors are reconnected to its successors)
- {"op":"add_transition","from":"id","to":"id","condition":"…"} | {"op":"remove_transition","from":"id","to":"id"}
- {"op":"set_entry","id":"script id"}
- {"op":"set_permission","system":"system id","scope":"scope","level":"allow|approval|deny"}
- {"op":"set_script_approval","id":"script id","required":true,"reason":"…"}
- {"op":"set_browser","enabled"?:bool,"add_domains"?:[],"remove_domains"?:[]}
- {"op":"grant_collection","collection_id":"…"} | {"op":"revoke_collection","collection_id":"…"}
- {"op":"add_memory","kind":"instructions|business|long_term","content":"…"}
- {"op":"add_trigger","trigger":{"type":"manual|schedule","label","input","entryScript","schedule":{"everyMinutes":0,"dailyAt":"HH:MM"}}} | {"op":"remove_trigger","id":"trigger id"}
- {"op":"run_task","input":"instruction for a new task","entry_script":"optional script id"}`;

export function employeeDigest(employee, collections = []) {
  return {
    name: employee.name, role: employee.role, summary: employee.summary, status: employee.status,
    instructions: truncate(employee.instructions, 1500), rules: employee.rules, goals: employee.goals,
    entryScript: employee.entryScript,
    scripts: employee.scripts.map((s) => ({
      id: s.id, name: s.name, description: s.description, instructions: truncate(s.instructions, 500),
      tools: s.tools, next: s.next, approval: s.approval, failure: s.failure.strategy,
    })),
    triggers: employee.triggers.map((t) => ({ id: t.id, type: t.type, label: t.label, schedule: t.schedule, enabled: t.enabled })),
    permissions: employee.permissions,
    browser: employee.browser,
    granted_collections: (employee.collections || []).map((id) => ({ id, name: collections.find((c) => c.id === id)?.name || id })),
    available_collections: collections.map((c) => ({ id: c.id, name: c.name })),
  };
}

export async function interpretInstruction(ai, { employee, instruction, history = [], collections = [] }) {
  const system = `You are the WorkForce AI engine's configuration controller. You modify an AI employee's actual architecture in response to the owner's instructions by emitting structured operations. If the owner asks a question, answer it from the configuration (operations may be empty). If the owner asks the employee to do work now, emit run_task. Only use tools from the catalog and systems that exist. Reply with a single JSON object.`;
  const prompt = `<employee_configuration>
${JSON.stringify(employeeDigest(employee, collections), null, 1)}
</employee_configuration>

<tool_catalog>
${catalogForPrompt()}
</tool_catalog>
Permission systems and scopes: ${Object.entries(SYSTEMS).map(([k, v]) => `${k}(${v.scopes.join('/')})`).join(', ')}

${OPS_DOC}

<recent_conversation>
${history.slice(-6).map((m) => `${m.role}: ${truncate(m.text, 400)}`).join('\n')}
</recent_conversation>

<owner_instruction>
${instruction}
</owner_instruction>

Return JSON: {"reply":"short confirmation or answer addressed to the owner, describing exactly what changed","operations":[…]}`;
  const { data } = await chatJSON(ai, { system, prompt, maxTokens: 10000 });
  return { reply: String(data.reply || ''), operations: Array.isArray(data.operations) ? data.operations : [] };
}

/** Apply operations to a copy of the employee. Returns {employee, results, runTasks}. */
export function applyOperations(original, operations, { collections = [] } = {}) {
  const e = clone(original);
  const results = [];
  const runTasks = [];
  const ids = () => new Set(e.scripts.map((s) => s.id));
  const find = (id) => e.scripts.find((s) => s.id === slug(id));
  const ok = (op, message) => results.push({ op: op.op, ok: true, message });
  const fail = (op, message) => results.push({ op: op.op, ok: false, message });

  for (const op of operations) {
    try {
      switch (op.op) {
        case 'update_profile': {
          const c = op.changes || {};
          for (const k of ['name', 'role', 'summary', 'instructions']) if (typeof c[k] === 'string' && c[k].trim()) e[k] = c[k].trim();
          if (c.name) e.avatar.initials = c.name.slice(0, 2).toUpperCase();
          ok(op, `Updated ${Object.keys(c).join(', ')}`);
          break;
        }
        case 'add_rule': e.rules.push(String(op.rule)); ok(op, `Added rule: ${op.rule}`); break;
        case 'remove_rule': {
          const before = e.rules.length;
          e.rules = e.rules.filter((r) => !r.toLowerCase().includes(String(op.text || '').toLowerCase()));
          before === e.rules.length ? fail(op, 'Rule not found') : ok(op, 'Removed rule');
          break;
        }
        case 'add_goal': e.goals.push(String(op.goal)); ok(op, `Added goal: ${op.goal}`); break;
        case 'add_script': {
          const used = ids();
          const s = normalizeScript(op.script || {}, e.scripts.length, used);
          const existing = new Set(e.scripts.map((x) => x.id).concat(s.id));
          s.next = s.next.filter((n) => existing.has(n.script));
          e.scripts.push(s);
          const after = op.after ? find(op.after) : null;
          if (after) {
            if (op.replace_edges) {
              s.next = s.next.length ? s.next : after.next.slice();
              after.next = [];
            }
            after.next.push({ script: s.id, condition: String(op.condition || '') });
          }
          ok(op, `Added script “${s.name}”${after ? ` after ${after.name}` : ''}`);
          break;
        }
        case 'update_script': {
          const s = find(op.id);
          if (!s) { fail(op, `Script ${op.id} not found`); break; }
          const c = op.changes || {};
          const merged = normalizeScript({ ...s, ...c, id: s.id, failure: { ...s.failure, ...(c.failure || {}) }, approval: { ...s.approval, ...(c.approval || {}) } }, 0, new Set());
          merged.id = s.id;
          merged.next = merged.next.filter((n) => ids().has(n.script));
          Object.assign(s, merged);
          ok(op, `Updated script “${s.name}” (${Object.keys(c).join(', ')})`);
          break;
        }
        case 'remove_script': {
          const s = find(op.id);
          if (!s) { fail(op, `Script ${op.id} not found`); break; }
          e.scripts = e.scripts.filter((x) => x.id !== s.id);
          for (const x of e.scripts) {
            if (x.next.some((n) => n.script === s.id)) {
              const cond = x.next.find((n) => n.script === s.id).condition;
              x.next = x.next.filter((n) => n.script !== s.id);
              for (const n of s.next) if (n.script !== x.id && !x.next.some((m) => m.script === n.script)) x.next.push({ script: n.script, condition: n.condition || cond });
            }
            if (x.failure.escalateTo === s.id) x.failure.escalateTo = '';
          }
          if (e.entryScript === s.id) e.entryScript = s.next[0]?.script || e.scripts[0]?.id;
          e.triggers.forEach((t) => { if (t.entryScript === s.id) t.entryScript = e.entryScript; });
          ok(op, `Removed script “${s.name}”`);
          break;
        }
        case 'add_transition': {
          const a = find(op.from); const b = find(op.to);
          if (!a || !b) { fail(op, 'Unknown script in transition'); break; }
          const existing = a.next.find((n) => n.script === b.id);
          if (existing) existing.condition = String(op.condition || existing.condition);
          else a.next.push({ script: b.id, condition: String(op.condition || '') });
          ok(op, `Connected ${a.name} → ${b.name}`);
          break;
        }
        case 'remove_transition': {
          const a = find(op.from);
          if (!a) { fail(op, 'Unknown script'); break; }
          a.next = a.next.filter((n) => n.script !== slug(op.to));
          ok(op, `Disconnected ${a.name} → ${op.to}`);
          break;
        }
        case 'set_entry': {
          const s = find(op.id);
          if (!s) { fail(op, 'Unknown script'); break; }
          e.entryScript = s.id;
          ok(op, `Entry script is now ${s.name}`);
          break;
        }
        case 'set_permission': {
          if (!SYSTEMS[op.system] || !SYSTEMS[op.system].scopes.includes(op.scope) || !['allow', 'approval', 'deny'].includes(op.level)) { fail(op, 'Invalid permission'); break; }
          e.permissions[op.system] = e.permissions[op.system] || {};
          e.permissions[op.system][op.scope] = op.level;
          ok(op, `${SYSTEMS[op.system].name} ${op.scope}: ${op.level}`);
          break;
        }
        case 'set_script_approval': {
          const s = find(op.id);
          if (!s) { fail(op, 'Unknown script'); break; }
          s.approval = { required: !!op.required, reason: String(op.reason || s.approval.reason || '') };
          ok(op, `${s.name}: approval ${s.approval.required ? 'required' : 'not required'}`);
          break;
        }
        case 'set_browser': {
          if (typeof op.enabled === 'boolean') e.browser.enabled = op.enabled;
          const clean = (d) => String(d).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
          for (const d of op.add_domains || []) if (!e.browser.domains.includes(clean(d))) e.browser.domains.push(clean(d));
          e.browser.domains = e.browser.domains.filter((d) => !(op.remove_domains || []).map(clean).includes(d));
          ok(op, `Browser ${e.browser.enabled ? 'enabled' : 'disabled'}; domains: ${e.browser.domains.join(', ') || 'working tab only'}`);
          break;
        }
        case 'grant_collection': {
          const c = collections.find((x) => x.id === op.collection_id || x.name.toLowerCase() === String(op.collection_id).toLowerCase());
          if (!c) { fail(op, 'Collection not found'); break; }
          if (!e.collections.includes(c.id)) e.collections.push(c.id);
          e.permissions.files = { read: 'allow' };
          ok(op, `Granted read access to “${c.name}”`);
          break;
        }
        case 'revoke_collection': {
          e.collections = e.collections.filter((id) => id !== op.collection_id);
          ok(op, 'Revoked collection access');
          break;
        }
        case 'add_memory':
          results.push({ op: 'add_memory', ok: true, message: `Remembered: ${truncate(op.content, 80)}`, memory: { kind: op.kind || 'long_term', content: String(op.content) } });
          break;
        case 'add_trigger': {
          const [t] = normalizeTriggers([op.trigger || {}], e.entryScript, ids()).filter((x) => x.type !== 'manual' || (op.trigger?.type === 'manual'));
          if (!t) { fail(op, 'Invalid trigger'); break; }
          t.enabled = true;
          t.nextRunAt = scheduleNext(t);
          e.triggers.push(t);
          ok(op, `Added trigger “${t.label}”`);
          break;
        }
        case 'remove_trigger': {
          e.triggers = e.triggers.filter((t) => t.id !== op.id);
          ok(op, 'Removed trigger');
          break;
        }
        case 'run_task':
          runTasks.push({ input: String(op.input || ''), entryScript: op.entry_script || '' });
          ok(op, `Starting task: ${truncate(op.input, 80)}`);
          break;
        default:
          fail(op, `Unsupported operation ${op.op}`);
      }
    } catch (err) {
      fail(op, err.message);
    }
  }
  for (const s of e.scripts) s.tools = s.tools.filter((t) => TOOL_MAP[t] && !TOOL_MAP[t].internal);
  e.systems = usedSystems(e);
  return { employee: e, results, runTasks };
}

export async function saveVersion(db, employee, reason) {
  await db.put('versions', { id: uid('ver'), employeeId: employee.id, version: employee.version, reason, snapshot: clone(employee), createdAt: now() });
}

/** Interpret + apply + persist. */
export async function modifyEmployee({ db, ai, employee, instruction, history, collections, connections, actor = 'chat' }) {
  const { reply, operations } = await interpretInstruction(ai, { employee, instruction, history, collections });
  const configOps = operations.filter((o) => o.op !== 'run_task');
  const { employee: updated, results, runTasks } = applyOperations(employee, operations, { collections });
  const changed = configOps.length && results.some((r) => r.ok && r.op !== 'run_task');
  if (changed) {
    await saveVersion(db, employee, instruction);
    updated.version = (employee.version || 1) + 1;
    updated.updatedAt = now();
    updated.tests = validateEmployee(updated, { connections, collections });
    await db.put('employees', updated);
    for (const r of results) if (r.memory) await addMemory(db, updated.id, r.memory.kind, r.memory.content, { source: actor });
    await db.put('activity', {
      id: uid('act'), ts: now(), employeeId: updated.id, taskId: null, origin: 'app', type: 'config_changed', status: 'info',
      message: `Configuration changed via ${actor}: ${results.filter((r) => r.ok).map((r) => r.message).join('; ')}`, input: instruction,
    });
  }
  return { reply, operations, results, runTasks, employee: changed ? updated : employee, changed: !!changed };
}

export async function restoreVersion(db, versionId) {
  const v = await db.get('versions', versionId);
  if (!v) throw new Error('Version not found');
  const current = await db.get('employees', v.employeeId);
  if (current) await saveVersion(db, current, `Before restoring v${v.version}`);
  const restored = { ...clone(v.snapshot), version: (current?.version || v.version) + 1, updatedAt: now(), status: current?.status || v.snapshot.status };
  await db.put('employees', restored);
  await db.put('activity', { id: uid('act'), ts: now(), employeeId: restored.id, taskId: null, origin: 'app', type: 'config_changed', status: 'info', message: `Restored configuration from v${v.version}` });
  return restored;
}
