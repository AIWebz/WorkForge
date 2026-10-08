// WorkForge AI engine host. Runs an open-source language model entirely on the
// user's device (WebGPU) through WebLLM in a web worker. No API, no account, no
// key, and nothing to configure: the engine picks the best model this GPU can
// hold, downloads it once (from this site when self-hosted, otherwise the public
// open-model mirror), caches it, and falls back to a smaller model if needed.

// Candidate models, best first. f32 builds are used on GPUs without 16-bit shaders.
export const MODELS = [
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-3B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 3B', vramMB: 2505 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 1.5B', vramMB: 1630 },
];
export const CONTEXT_WINDOW = 16384;
const SKIP_KEY = 'workforge.engine.skip';
const OUT_OF_MEMORY = /memory|device (was )?lost|exceeds? (the )?limit|maxBufferSize|maxStorageBufferBindingSize|allocat/i;

// The engine worker reports errors as strings ("TypeError: Failed to fetch").
const asError = (err) => (err instanceof Error ? err : new Error(String(err ?? 'Unknown error').replace(/^\w*Error: /, '')));

export function modelInfo(id) {
  return MODELS.find((m) => m.id === id || m.f32 === id) || { id, label: id || 'Automatic', vramMB: 0 };
}

const store = {
  get() { try { return JSON.parse(globalThis.localStorage?.getItem(SKIP_KEY) || '[]'); } catch { return []; } },
  add(id) { try { const s = new Set(store.get()); s.add(id); globalThis.localStorage?.setItem(SKIP_KEY, JSON.stringify([...s])); } catch { /* ignore */ } },
  clear() { try { globalThis.localStorage?.removeItem(SKIP_KEY); } catch { /* ignore */ } },
};

/**
 * @param {object} o
 * @param {string} o.webllmUrl  absolute URL of the bundled web-llm.js module
 * @param {string|URL} o.workerUrl  URL of the module worker that hosts the engine
 */
export function createEngineHost({ webllmUrl, workerUrl, contextWindow = CONTEXT_WINDOW }) {
  let engine = null;
  let worker = null;
  let loadedKey = '';
  let loading = null;
  let queue = Promise.resolve();
  let gpu = null;
  const listeners = new Set();
  const status = { state: 'idle', progress: 0, text: 'Not loaded yet', model: '' };
  const set = (patch) => { Object.assign(status, patch); for (const f of [...listeners]) { try { f({ ...status }); } catch { /* ignore */ } } };
  const lib = () => import(webllmUrl);

  async function gpuInfo() {
    if (gpu) return gpu;
    if (!globalThis.navigator?.gpu) return (gpu = { supported: false, reason: 'This browser does not support WebGPU. Use a recent Chrome, Edge or Brave on a computer with a GPU.' });
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return (gpu = { supported: false, reason: 'No compatible GPU was found for WebGPU.' });
      gpu = {
        supported: true,
        f16: adapter.features?.has?.('shader-f16') ?? false,
        fallback: !!adapter.isFallbackAdapter,
        maxBuffer: adapter.limits?.maxBufferSize || 0,
        vendor: adapter.info?.vendor || '',
      };
    } catch (e) {
      gpu = { supported: false, reason: `WebGPU failed to start: ${e.message}` };
    }
    return gpu;
  }

  /** Ordered model ids to try for this device (best first). */
  async function candidates(cfg = {}) {
    const info = await gpuInfo();
    if (!info.supported) throw new Error(info.reason);
    const lowEnd = info.fallback || (globalThis.navigator?.deviceMemory && navigator.deviceMemory <= 4) || (info.maxBuffer && info.maxBuffer < 1024 ** 3);
    let list = lowEnd ? MODELS.slice(1) : MODELS.slice();
    const pick = (m) => (info.f16 ? m.id : m.f32);
    // Prefer the builds this site hosts; any other build still comes from the public mirror.
    const hosted = cfg.source?.base ? (cfg.hosted || []) : [];
    if (hosted.length) list = [...list].sort((a, b) => hosted.includes(pick(b)) - hosted.includes(pick(a)));
    const ids = list.map(pick);
    const skip = new Set(store.get());
    const usable = ids.filter((id) => !skip.has(id));
    return usable.length ? usable : ids.slice(-1);
  }

  function appConfigFor(webllm, cfg) {
    const base = cfg?.source?.base;
    const hosted = cfg?.hosted || [];
    if (!base || !hosted.length) return webllm.prebuiltAppConfig;
    // Self-hosted builds: weights at <base>models/<id>/resolve/main/, libraries at <base>models/libs/.
    return {
      ...webllm.prebuiltAppConfig,
      model_list: webllm.prebuiltAppConfig.model_list.map((r) => (hosted.includes(r.model_id) ? {
        ...r,
        model: `${base}models/${r.model_id}/`,
        model_lib: `${base}models/libs/${r.model_lib.split('/').pop()}`,
      } : r)),
    };
  }

  // Bumped by unload(): loads and generations started before it are abandoned.
  // (The WebLLM client only settles through worker messages, so a terminated or
  // failed worker would otherwise leave its promises pending forever.)
  let gen = 0;
  const stoppers = new Set();
  const stopped = () => Object.assign(new Error('The AI engine was stopped'), { code: 'stopped' });
  function stoppable(promise, w) {
    return new Promise((resolve, reject) => {
      const stop = () => reject(stopped());
      stoppers.add(stop);
      w?.addEventListener('error', (e) => reject(new Error(e.message || 'The AI engine could not start in this browser')), { once: true });
      promise.then(resolve, reject).finally(() => stoppers.delete(stop));
    });
  }

  async function loadModel(webllm, id, cfg) {
    set({ state: 'loading', model: id, progress: 0, text: 'Starting the AI engine…' });
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
    engine = null;
    const w = (worker = new Worker(workerUrl, { type: 'module' }));
    return stoppable(webllm.CreateWebWorkerMLCEngine(w, id, {
      appConfig: appConfigFor(webllm, cfg),
      initProgressCallback: (r) => set({ state: 'loading', progress: r.progress ?? 0, text: r.text || 'Loading…' }),
    }, { context_window_size: contextWindow }), w);
  }

  /** Returns a ready engine, choosing and loading the model automatically. */
  async function get(cfg = {}) {
    const base = cfg.source?.base || '';
    if (engine && loadedKey.endsWith(`|${base}`)) return engine;
    if (loading) return loading;
    const my = gen;
    const p = (async () => {
      const webllm = await lib();
      const ids = await candidates(cfg);
      let lastErr = null;
      for (const id of ids) {
        if (my !== gen) throw stopped();
        try {
          const e = await loadModel(webllm, id, cfg);
          if (my !== gen) throw stopped();
          engine = e;
          loadedKey = `${id}|${base}`;
          set({ state: 'ready', progress: 1, text: 'Ready on this device', model: id });
          return engine;
        } catch (err) {
          if (my !== gen) throw stopped();
          lastErr = asError(err);
          // Too big for this GPU: skip it from now on. Network errors are retried next time.
          if (ids.indexOf(id) < ids.length - 1 && OUT_OF_MEMORY.test(lastErr.message)) store.add(id);
        }
      }
      // Free the GPU memory a half-loaded model may still hold.
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      throw lastErr || new Error('The AI engine could not start');
    })().catch((err) => {
      const e = asError(err);
      if (my === gen) set({ state: 'error', text: e.message });
      throw e;
    }).finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  }

  // The engine handles one generation at a time; serialize callers.
  function run(fn) {
    const p = queue.then(() => stoppable(Promise.resolve().then(fn)));
    queue = p.catch(() => {});
    return p;
  }

  async function deleteCache(cfg = {}) {
    const webllm = await lib();
    await unload();
    const info = await gpuInfo();
    for (const m of MODELS) {
      for (const id of [m.id, m.f32]) {
        try { await webllm.deleteModelAllInfoInCache(id, appConfigFor(webllm, cfg)); } catch { /* not cached */ }
      }
    }
    store.clear();
    void info;
  }

  async function unload() {
    gen++;
    loading = null;
    for (const stop of [...stoppers]) stop();
    try { if (engine) await Promise.race([engine.unload(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* ignore */ }
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
    engine = null;
    worker = null;
    loadedKey = '';
    set({ state: 'idle', progress: 0, text: 'Not loaded yet', model: '' });
  }

  return {
    status,
    onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get, run, gpuInfo, candidates, deleteCache, unload,
  };
}
