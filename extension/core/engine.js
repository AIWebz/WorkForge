// WorkForge AI engine host. Runs an open-source language model entirely on the
// user's device (WebGPU) through WebLLM in a web worker. No API, no account, no
// key: model weights are downloaded once (from this site when self-hosted, or
// the public model mirror) and cached by the browser.

export const MODELS = [
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 3B', note: 'Balanced — recommended', vramMB: 2505 },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-7B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 7B', note: 'Best quality — needs a strong GPU', vramMB: 5107 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 1.5B', note: 'Fastest — smaller GPUs, simpler work', vramMB: 1630 },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 · 3B', note: 'Alternative 3B model', vramMB: 2264 },
];
export const DEFAULT_MODEL = MODELS[0].id;
export const CONTEXT_WINDOW = 16384;

export function modelInfo(id) {
  return MODELS.find((m) => m.id === id || m.f32 === id) || { id, label: id, note: '', vramMB: 0 };
}

/**
 * @param {object} o
 * @param {string} o.webllmUrl  absolute URL of the vendored web-llm.js module
 * @param {string|URL} o.workerUrl  URL of the module worker that hosts the engine
 */
export function createEngineHost({ webllmUrl, workerUrl, contextWindow = CONTEXT_WINDOW }) {
  let engine = null;
  let worker = null;
  let loadedKey = '';
  let loading = null;
  let loadingKey = '';
  let queue = Promise.resolve();
  let gpu = null;
  const listeners = new Set();
  const status = { state: 'idle', progress: 0, text: 'Not loaded', model: '' };
  const set = (patch) => { Object.assign(status, patch); for (const f of [...listeners]) { try { f({ ...status }); } catch { /* ignore */ } } };
  const lib = () => import(webllmUrl);

  async function gpuInfo() {
    if (gpu) return gpu;
    if (!globalThis.navigator?.gpu) return (gpu = { supported: false, reason: 'This browser does not support WebGPU. Use a recent Chrome, Edge or Brave on a computer with a GPU.' });
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return (gpu = { supported: false, reason: 'No compatible GPU was found for WebGPU.' });
      gpu = { supported: true, f16: adapter.features?.has?.('shader-f16') ?? false, vendor: adapter.info?.vendor || '' };
    } catch (e) {
      gpu = { supported: false, reason: `WebGPU failed to start: ${e.message}` };
    }
    return gpu;
  }

  function appConfigFor(webllm, cfg) {
    const base = cfg?.source?.base;
    if (!base) return webllm.prebuiltAppConfig;
    // Self-hosted: weights at <base>models/<id>/resolve/main/, libraries at <base>models/libs/.
    return {
      ...webllm.prebuiltAppConfig,
      model_list: webllm.prebuiltAppConfig.model_list.map((r) => ({
        ...r,
        model: `${base}models/${r.model_id}/`,
        model_lib: `${base}models/libs/${r.model_lib.split('/').pop()}`,
      })),
    };
  }

  async function resolveId(cfg) {
    const info = await gpuInfo();
    if (!info.supported) throw new Error(info.reason);
    const m = MODELS.find((x) => x.id === cfg.model);
    return !info.f16 && m?.f32 ? m.f32 : cfg.model;
  }

  async function get(cfg) {
    if (!cfg?.model) throw new Error('Choose an AI model in Settings → AI Engine.');
    const id = await resolveId(cfg);
    const key = `${id}|${cfg.source?.base || ''}`;
    if (engine && loadedKey === key) return engine;
    if (loading && loadingKey === key) return loading;
    loadingKey = key;
    loading = (async () => {
      const webllm = await lib();
      set({ state: 'loading', model: id, progress: 0, text: 'Starting the AI engine…' });
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
      engine = null;
      worker = new Worker(workerUrl, { type: 'module' });
      const e = await webllm.CreateWebWorkerMLCEngine(worker, id, {
        appConfig: appConfigFor(webllm, cfg),
        initProgressCallback: (r) => set({ state: 'loading', progress: r.progress ?? 0, text: r.text || 'Loading…' }),
      }, { context_window_size: contextWindow });
      engine = e;
      loadedKey = key;
      set({ state: 'ready', progress: 1, text: 'Ready on this device', model: id });
      return e;
    })().catch((err) => {
      set({ state: 'error', text: err.message || String(err) });
      throw err;
    }).finally(() => { loading = null; loadingKey = ''; });
    return loading;
  }

  // The engine handles one generation at a time; serialize callers.
  function run(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  async function isCached(cfg) {
    try {
      const webllm = await lib();
      return await webllm.hasModelInCache(await resolveId(cfg), appConfigFor(webllm, cfg));
    } catch { return false; }
  }

  async function deleteCache(cfg) {
    const webllm = await lib();
    await unload();
    await webllm.deleteModelAllInfoInCache(await resolveId(cfg), appConfigFor(webllm, cfg));
  }

  async function unload() {
    try { if (engine) await engine.unload(); } catch { /* ignore */ }
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
    engine = null;
    worker = null;
    loadedKey = '';
    set({ state: 'idle', progress: 0, text: 'Not loaded', model: '' });
  }

  return {
    status,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get, run, gpuInfo, isCached, deleteCache, unload,
  };
}
