// WorkForge AI engine interface. Every call runs on the local engine host
// (engine.js): an open-source model executing on the user's own device. There
// is no external AI provider, API or key.
//
// Tool use is implemented with schema-constrained JSON: each turn the model
// must produce {"thought", "tool", "args"} matching one of the offered tools,
// which the engine enforces with grammar-guided decoding.
import { uid, extractJSON } from './util.js';

let host = null;

/** Register the engine host for this context (web app tab or extension side panel). */
export function setEngineHost(h) { host = h; }
export function engineHost() { return host; }

export class AIError extends Error {
  constructor(message, { code } = {}) { super(message); this.code = code; }
}

// The model is chosen automatically by the engine host; any config object works.
export function isConfigured(cfg) {
  return !!cfg;
}

// Approximate character budget for a conversation (context window is 16k tokens).
const HISTORY_CHAR_BUDGET = 36000;
const KEEP_RECENT_RESULTS = 2;
const ANY_OBJECT = { type: 'object' };

function trimHistory(messages) {
  let total = messages.reduce((a, m) => a + String(m.content).length, 0);
  if (total <= HISTORY_CHAR_BUDGET) return messages;
  const out = messages.map((m) => ({ ...m }));
  const resultIdx = out.map((m, i) => (m.role === 'user' && m.toolResults ? i : -1)).filter((i) => i >= 0);
  for (const i of resultIdx.slice(0, -KEEP_RECENT_RESULTS)) {
    if (total <= HISTORY_CHAR_BUDGET) break;
    total -= out[i].content.length;
    out[i].content = '[Earlier tool results omitted to save memory.]';
    total += out[i].content.length;
  }
  return out;
}

function compactSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const props = s.properties || {};
  const req = new Set(s.required || []);
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [`${k}${req.has(k) ? '' : '?'}`, `${v.type || 'any'}${v.enum ? ` (${v.enum.join('|')})` : ''}${v.description ? ` — ${v.description}` : ''}`]));
}

function toolProtocol(tools) {
  return [
    '## Tools',
    'Every reply must be exactly one JSON object: {"thought": "<one short sentence>", "tool": "<tool name>", "args": {…}}.',
    'Call one tool per reply. You will receive its result, then decide the next call.',
    ...tools.map((t) => `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(compactSchema(t.input_schema))}`),
  ].join('\n');
}

function toolCallSchema(tools) {
  return {
    anyOf: tools.map((t) => ({
      type: 'object',
      properties: {
        thought: { type: 'string' },
        tool: { type: 'string', enum: [t.name] },
        args: t.input_schema && Object.keys(t.input_schema.properties || {}).length ? t.input_schema : { type: 'object' },
      },
      required: ['thought', 'tool', 'args'],
    })),
  };
}

/**
 * One model turn.
 * @returns {{text:string, toolCalls:Array<{id,name,args}>, assistant:object, stopReason:string, usage:object}}
 */
export async function chat(cfg, { system, messages, tools = [], maxTokens = 2048, json = false, schema = null, signal } = {}) {
  if (!host) throw new AIError('The AI engine is not available here.', { code: 'no_engine' });
  if (signal?.aborted) throw new AIError('Request cancelled', { code: 'aborted' });
  const engine = await host.get(cfg);
  const sys = [system, tools.length ? toolProtocol(tools) : ''].filter(Boolean).join('\n\n');
  const body = {
    messages: [{ role: 'system', content: sys }, ...trimHistory(messages).map((m) => ({ role: m.role, content: String(m.content) }))],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  // WebLLM's json_object mode always compiles a JSON schema (a missing schema
  // fails with "Cannot pass non-string to std::string"), so always send one.
  if (tools.length) body.response_format = { type: 'json_object', schema: JSON.stringify(toolCallSchema(tools)) };
  else if (json || schema) body.response_format = { type: 'json_object', schema: JSON.stringify(schema || ANY_OBJECT) };

  let res;
  try {
    res = await host.run(() => engine.chat.completions.create(body));
  } catch (e) {
    // If constrained decoding cannot start, answer unconstrained once; the
    // caller still parses and validates the JSON.
    if (!body.response_format || !/grammar|schema|std::string/i.test(String(e?.message || e))) {
      throw new AIError(`The AI engine failed: ${e.message || e}`, { code: 'engine' });
    }
    delete body.response_format;
    try {
      res = await host.run(() => engine.chat.completions.create(body));
    } catch (e2) {
      throw new AIError(`The AI engine failed: ${e2.message || e2}`, { code: 'engine' });
    }
  }
  if (signal?.aborted) throw new AIError('Request cancelled', { code: 'aborted' });
  const choice = res.choices?.[0] || {};
  const text = choice.message?.content || '';
  const usage = { input: res.usage?.prompt_tokens || 0, output: res.usage?.completion_tokens || 0 };
  const assistant = { role: 'assistant', content: text };
  if (!tools.length) return { text, toolCalls: [], assistant, stopReason: choice.finish_reason, usage };

  let call = null;
  try { call = extractJSON(text); } catch { call = null; }
  const toolCalls = call && typeof call.tool === 'string' && tools.some((t) => t.name === call.tool)
    ? [{ id: uid('call'), name: call.tool, args: call.args && typeof call.args === 'object' ? call.args : {} }]
    : [];
  return { text: call?.thought || (toolCalls.length ? '' : text), toolCalls, assistant, stopReason: choice.finish_reason, usage };
}

export function userMessage(cfg, content) {
  return { role: 'user', content: String(content) };
}

// Tool results for one assistant turn, as conversation messages.
export function toolResultMessages(cfg, results) {
  const body = results.map((r) => {
    const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    return `[${r.name}${r.isError ? ' — ERROR' : ''}] ${content}`;
  }).join('\n\n');
  return [{ role: 'user', toolResults: true, content: `Tool results:\n${body}\n\nDecide the next step.` }];
}

// Ask for a JSON object (optionally matching a JSON schema).
export async function chatJSON(cfg, { system, prompt, schema = null, maxTokens = 4096, signal }) {
  const messages = [userMessage(cfg, prompt)];
  const first = await chat(cfg, { system, messages, json: true, schema, maxTokens, signal });
  try {
    return { data: extractJSON(first.text), usage: first.usage };
  } catch {
    messages.push(first.assistant, userMessage(cfg, 'That was not valid JSON. Reply again with only the complete JSON object.'));
    const second = await chat(cfg, { system, messages, json: true, schema, maxTokens, signal });
    return { data: extractJSON(second.text), usage: second.usage };
  }
}

/** Load the model (downloading it on first use) and run a tiny prompt. */
export async function testEngine(cfg) {
  const r = await chat(cfg, { system: 'You are a connectivity check.', messages: [userMessage(cfg, 'Reply with the single word: ready')], maxTokens: 16 });
  return { ok: /ready/i.test(r.text), text: r.text.trim().slice(0, 80), model: host?.status?.model || '' };
}
