// AI engine transport. Calls the model provider directly from the browser with
// the user's own API key (never bundled in source). Supports the Claude API
// (default) and any OpenAI-compatible endpoint (OpenAI, OpenRouter, local Ollama…).
import { sleep, extractJSON } from './util.js';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude API)',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
    keyHint: 'sk-ant-…',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    defaultModel: '',
    keyHint: 'sk-…',
  },
  compatible: {
    label: 'OpenAI-compatible endpoint',
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    defaultModel: '',
    keyHint: 'optional',
  },
};

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export class AIError extends Error {
  constructor(message, { status, retryable = false, code } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

export function isConfigured(cfg) {
  if (!cfg || !cfg.provider || !cfg.model) return false;
  if (cfg.provider === 'compatible') return !!cfg.baseUrl;
  return !!cfg.apiKey;
}

/**
 * One model turn.
 * @returns {{text:string, toolCalls:Array<{id,name,args}>, assistant:object, stopReason:string, usage:object}}
 */
export async function chat(cfg, { system, messages, tools = [], maxTokens = 16000, signal } = {}) {
  if (!isConfigured(cfg)) throw new AIError('AI engine is not configured. Add a provider and API key in Settings → AI Engine.', { code: 'not_configured' });
  const fn = cfg.provider === 'anthropic' ? anthropicChat : openaiChat;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(cfg, { system, messages, tools, maxTokens, signal });
    } catch (e) {
      attempt++;
      if (!e.retryable || attempt > 3 || signal?.aborted) throw e;
      await sleep(e.retryAfter || 1500 * 2 ** (attempt - 1));
    }
  }
}

export function userMessage(cfg, content) {
  return { role: 'user', content };
}

// Tool results for one assistant turn, returned as an array of native messages.
export function toolResultMessages(cfg, results) {
  if (cfg.provider === 'anthropic') {
    return [{
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        ...(r.isError ? { is_error: true } : {}),
      })),
    }];
  }
  return results.map((r) => ({
    role: 'tool',
    tool_call_id: r.id,
    content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
  }));
}

// Ask for a JSON object; retries once with a repair instruction if parsing fails.
export async function chatJSON(cfg, { system, prompt, maxTokens = 16000, signal }) {
  const messages = [userMessage(cfg, prompt)];
  const first = await chat(cfg, { system, messages, maxTokens, signal });
  try {
    return { data: extractJSON(first.text), usage: first.usage };
  } catch {
    messages.push(first.assistant, userMessage(cfg, 'Your previous reply was not valid JSON. Reply again with ONLY the complete JSON object, no prose.'));
    const second = await chat(cfg, { system, messages, maxTokens, signal });
    return { data: extractJSON(second.text), usage: second.usage };
  }
}

export async function testConnection(cfg) {
  const r = await chat(cfg, {
    system: 'You are a connectivity check.',
    messages: [userMessage(cfg, 'Reply with the single word: ready')],
    maxTokens: 2048,
  });
  return { ok: /ready/i.test(r.text), text: r.text.trim().slice(0, 80), model: cfg.model };
}

export async function describeImage(cfg, dataUrl, instruction) {
  const [meta, data] = dataUrl.split(',');
  const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const content = cfg.provider === 'anthropic'
    ? [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }, { type: 'text', text: instruction }]
    : [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: instruction }];
  const r = await chat(cfg, { system: 'You extract text and describe business documents precisely.', messages: [{ role: 'user', content }], maxTokens: 4000 });
  return r.text;
}

// ---------------------------------------------------------------- Anthropic
async function anthropicChat(cfg, { system, messages, tools, maxTokens, signal }) {
  const base = (cfg.baseUrl || PROVIDERS.anthropic.baseUrl).replace(/\/$/, '');
  const useFallback = FALLBACK_MODELS.has(cfg.model);
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    messages,
  };
  if (system) body.system = system;
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  }
  if (cfg.effort) body.output_config = { effort: cfg.effort };
  if (useFallback) body.fallbacks = 'default';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (useFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const res = await doFetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, json?.error?.message || json?.message);
  if (json.stop_reason === 'refusal') {
    throw new AIError(`The model declined this request${json.stop_details?.category ? ` (${json.stop_details.category})` : ''}.`, { code: 'refusal' });
  }
  const content = Array.isArray(json.content) ? json.content : [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  return {
    text,
    toolCalls,
    // Keep the full content (including thinking blocks) so it can be replayed unchanged.
    assistant: { role: 'assistant', content },
    stopReason: json.stop_reason,
    usage: { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0 },
  };
}

// ---------------------------------------------------------- OpenAI-compatible
async function openaiChat(cfg, { system, messages, tools, maxTokens, signal }) {
  const base = (cfg.baseUrl || PROVIDERS[cfg.provider]?.baseUrl || '').replace(/\/$/, '');
  const body = {
    model: cfg.model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
  };
  if (/api\.openai\.com/.test(base)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await doFetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, json?.error?.message || json?.message);
  const msg = json.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { _raw: tc.function?.arguments }; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  const assistant = { role: 'assistant', content: msg.content || '' };
  if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
  return {
    text: msg.content || '',
    toolCalls,
    assistant,
    stopReason: json.choices?.[0]?.finish_reason,
    usage: { input: json.usage?.prompt_tokens || 0, output: json.usage?.completion_tokens || 0 },
  };
}

async function doFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw new AIError('Request cancelled', { code: 'aborted' });
    throw new AIError(`Could not reach the AI provider at ${new URL(url).host}. Check the endpoint, your network, and that the provider allows browser (CORS) requests.`, { retryable: true, code: 'network' });
  }
}

function httpError(res, message) {
  const status = res.status;
  const retryable = status === 429 || status === 529 || status >= 500;
  const err = new AIError(
    status === 401 ? 'The AI provider rejected the API key (401). Update it in Settings → AI Engine.'
      : status === 404 ? `Model or endpoint not found (404): ${message || ''}`
        : `AI provider error ${status}: ${message || res.statusText}`,
    { status, retryable },
  );
  const ra = Number(res.headers.get('retry-after'));
  if (ra) err.retryAfter = Math.min(ra * 1000, 30000);
  return err;
}
