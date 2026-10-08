// Application context: database, credential vault, AI engine config, runtime,
// tool executor, scheduler and extension sync — the single source of truth the
// pages render from.
import { DB } from '../extension/core/db.js';
import { Runtime } from '../extension/core/runtime.js';
import { createToolExecutor } from '../extension/core/tools.js';
import { CONNECTIONS } from '../extension/core/catalog.js';
import { scheduleNext } from '../extension/core/employee.js';
import { Emitter, uid, now } from '../extension/core/util.js';
import { vault } from './vault.js';
import { bridge } from './bridge.js';
import { toast } from './ui.js';

export const db = new DB('workforge');
export const events = new Emitter();

export const app = {
  db, vault, bridge, events,
  jobs: {},
  isLeader: false,
  settings: { approveAllOutbound: false, shareCredentialsWithExtension: true },
  business: null,

  async load() {
    await db.open();
    this.settings = { ...this.settings, ...(await db.getSetting('security', {})) };
    this.business = await db.getSetting('business', null);
  },

  async getAI() {
    const cfg = await db.getSetting('ai', {});
    return { ...cfg, apiKey: vault.get('ai.apiKey') || '' };
  },

  async saveAI(cfg, apiKey) {
    await db.setSetting('ai', { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl || '', effort: cfg.effort || '' });
    if (apiKey !== undefined) await vault.set('ai.apiKey', apiKey);
    events.emit({ type: 'ai' });
  },

  async aiReady() {
    const c = await this.getAI();
    return !!(c.provider && c.model && (c.provider === 'compatible' ? c.baseUrl : c.apiKey));
  },

  async getConnection(id) {
    const c = await db.get('connections', id);
    if (!c) return null;
    return { ...c, secrets: vault.get(`conn.${id}`) || {} };
  },

  async connectionMap() {
    const rows = await db.all('connections');
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  },

  async saveBusiness(b) {
    this.business = b;
    await db.setSetting('business', b);
  },

  async saveSecurity(patch) {
    this.settings = { ...this.settings, ...patch };
    await db.setSetting('security', this.settings);
  },
};

// ---------------------------------------------------------------- transport
async function relay(url, init) {
  const r = await bridge.relayFetch(url, init);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? '' };
}

export const transport = {
  async fetch(url, init = {}, { mode = 'direct' } = {}) {
    const host = new URL(url).host;
    if (mode === 'relay') {
      if (!bridge.paired) throw new Error(`${host} does not accept requests from web pages (CORS). Install and connect the WorkForge extension (Browser Extension page) so it can relay this call.`);
      return relay(url, init);
    }
    try {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    } catch (e) {
      if (mode === 'direct-or-relay' && bridge.paired) return relay(url, init);
      throw new Error(`The request to ${host} was blocked by the browser (CORS or network).${bridge.paired ? '' : ' Connect the WorkForge extension to relay requests to services that block browsers.'}`);
    }
  },
};

export const executor = createToolExecutor({
  db,
  getConnection: (id) => app.getConnection(id),
  transport,
  browser: {
    async exec(action, args, { task }) {
      if (!bridge.paired) throw new Error('Browser tools need the WorkForge extension to be installed and connected.');
      return bridge.browserAction(task.browser.tabId, action, args);
    },
  },
  hooks: {
    async notify({ employee, task, title, message }) {
      await db.put('activity', { id: uid('act'), ts: now(), employeeId: employee.id, taskId: task?.id || null, origin: 'app', type: 'notification', status: 'info', message: `${title}: ${message}`, output: message });
      toast(`${employee.name}: ${title}`, 'info', 7000);
    },
  },
});

export const runtime = new Runtime({
  db,
  getAI: () => app.getAI(),
  executor,
  getSettings: async () => app.settings,
  getBusiness: async () => app.business,
  origin: 'app',
});
app.runtime = runtime;
app.executor = executor;

runtime.on((evt) => {
  if (evt.type === 'approval') toast(evt.approval.summary, 'info', 6000);
});

// ---------------------------------------------------------------- scheduler
async function schedulerTick() {
  if (!app.isLeader || vault.locked) return;
  const t = now();
  for (const emp of await db.all('employees')) {
    if (emp.status !== 'active') continue;
    let dirty = false;
    for (const trg of emp.triggers || []) {
      if (trg.type !== 'schedule' || !trg.enabled) continue;
      if (!trg.nextRunAt) { trg.nextRunAt = scheduleNext(trg, t); dirty = true; continue; }
      if (trg.nextRunAt <= t) {
        trg.lastRunAt = t;
        trg.nextRunAt = scheduleNext(trg, t);
        dirty = true;
        await runtime.createTask(emp, { input: trg.input || trg.description || trg.label, title: `${trg.label}`, trigger: `schedule: ${trg.label}`, entryScript: trg.entryScript });
      }
    }
    if (dirty) await db.put('employees', emp);
  }
  for (const s of await db.all('schedules')) {
    if (s.status !== 'scheduled' || s.runAt > t) continue;
    const emp = await db.get('employees', s.employeeId);
    if (!emp || emp.status === 'paused') continue;
    await db.put('schedules', { ...s, status: 'running', firedAt: t });
    await runtime.createTask(emp, { input: s.instruction, title: `Follow-up: ${s.instruction.slice(0, 70)}`, trigger: 'scheduled follow-up', entryScript: s.entryScript, scheduleId: s.id });
  }
}

export function startBackground() {
  // One tab is the leader: it runs schedules and resumes interrupted tasks.
  const becomeLeader = () => {
    app.isLeader = true;
    runtime.recover();
    schedulerTick();
  };
  if (navigator.locks?.request) {
    navigator.locks.request('workforge-leader', () => { becomeLeader(); return new Promise(() => {}); });
  } else becomeLeader();
  setInterval(schedulerTick, 20000);
  vault.onChange(() => { if (!vault.locked && app.isLeader) runtime.recover(); });

  bridge.detect().then(() => { if (bridge.paired) syncExtension().catch(() => {}); });
  bridge.on(() => { events.emit({ type: 'bridge' }); if (bridge.paired) syncExtension().catch(() => {}); });
  setInterval(async () => {
    await bridge.detect();
    if (bridge.paired) pullFromExtension().catch(() => {});
  }, 15000);
  let syncTimer;
  db.on((evt) => {
    if (!bridge.paired || evt.remote) return;
    if (['employees', 'memory', 'collections', 'chunks', 'connections'].includes(evt.store)) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncExtension().catch(() => {}), 1500);
    }
  });
}

// ---------------------------------------------------------------- extension sync
export async function syncExtension() {
  if (!bridge.paired) throw new Error('Extension not connected');
  const [employees, memory, collections, files, connections] = await Promise.all([
    db.all('employees'), db.all('memory'), db.all('collections'), db.all('files'), db.all('connections'),
  ]);
  const granted = new Set(employees.flatMap((e) => e.collections || []));
  const chunks = [];
  for (const cid of granted) chunks.push(...(await db.byIndex('chunks', 'collectionId', cid)));
  const share = app.settings.shareCredentialsWithExtension && !vault.locked;
  const secrets = {};
  if (share) {
    for (const c of connections) if (vault.get(`conn.${c.id}`)) secrets[c.id] = vault.get(`conn.${c.id}`);
  }
  const ai = share ? await app.getAI() : null;
  const r = await bridge.sync({
    employees, memory, collections, files: files.filter((f) => granted.has(f.collectionId)).map(({ dataUrl, ...f }) => f), chunks,
    connections, secrets, ai, business: app.business, settings: { approveAllOutbound: app.settings.approveAllOutbound },
    appUrl: location.origin + location.pathname,
    syncedAt: now(),
  });
  await pullFromExtension();
  return r;
}

export async function pullFromExtension() {
  const since = (await db.getSetting('ext.pulledAt', 0)) || 0;
  const r = await bridge.pull(since);
  if (!r) return;
  for (const store of ['tasks', 'activity', 'approvals']) {
    const rows = (r[store] || []).map((x) => ({ ...x, origin: 'extension' }));
    if (rows.length) await db.bulkPut(store, rows);
  }
  if (r.memory?.length) await db.bulkPut('memory', r.memory);
  await db.setSetting('ext.pulledAt', r.now || now());
}

export const CONNECTION_DEFS = CONNECTIONS;
