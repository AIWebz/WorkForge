// Application context: database, AI key vault, AI engine config, runtime,
// tool executor, scheduler and extension sync — the single source of truth the
// pages render from.
//
// There are no third-party API calls here. The only network traffic the app
// makes is to the user's AI provider (the AI engine). Employees work inside
// systems (web apps) through the WorkForge browser extension, in browser tabs
// that use the owner's own signed-in session.
import { DB } from '../extension/core/db.js';
import { Runtime } from '../extension/core/runtime.js';
import { createToolExecutor } from '../extension/core/tools.js';
import { SYSTEMS, hostOf } from '../extension/core/catalog.js';
import { scheduleNext } from '../extension/core/employee.js';
import { Emitter, uid, now } from '../extension/core/util.js';
import { vault } from './vault.js';
import { bridge } from './bridge.js';
import { toast } from './ui.js';

export const db = new DB('workforge');
export const events = new Emitter();

export const EXTENSION_REQUIRED = 'Install and connect the WorkForge browser extension so employees can work in your systems.';

export const app = {
  db, vault, bridge, events,
  jobs: {},
  isLeader: false,
  settings: { approveAllOutbound: false, shareAiKeyWithExtension: true },
  business: null,

  async load() {
    await db.open();
    const stored = await db.getSetting('security', {});
    const { shareCredentialsWithExtension, ...rest } = stored || {};
    this.settings = { approveAllOutbound: false, shareAiKeyWithExtension: true, ...rest };
    if (rest.shareAiKeyWithExtension === undefined && shareCredentialsWithExtension !== undefined) {
      this.settings.shareAiKeyWithExtension = !!shareCredentialsWithExtension;
    }
    if (shareCredentialsWithExtension !== undefined) await db.setSetting('security', this.settings);
    this.business = await migrateBusiness(await db.getSetting('business', null));
    await migrateConnections();
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

  /** Connected systems: rows of the `connections` store ({ id, url?, custom?, name?, description?, addedAt }). */
  getConnections() {
    return db.all('connections');
  },

  /** Convenience: connected systems keyed by system id. */
  async connectionMap() {
    const rows = await db.all('connections');
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  },

  async saveBusiness(b) {
    const clean = { description: b.description || '', automate: b.automate || '', systems: [...new Set(b.systems || [])] };
    this.business = clean;
    await db.setSetting('business', clean);
  },

  async saveSecurity(patch) {
    this.settings = { ...this.settings, ...patch };
    await db.setSetting('security', this.settings);
  },
};

// ---------------------------------------------------------------- migrations
// Business profile is { description, automate, systems: [systemId] } — no company name.
async function migrateBusiness(b) {
  if (!b) return null;
  const byName = Object.fromEntries(Object.entries(SYSTEMS).map(([id, s]) => [s.name.toLowerCase(), id]));
  const systems = [...new Set((b.systems || []).map((s) => (SYSTEMS[s] ? s : byName[String(s).toLowerCase()]))
    .flatMap((s) => (s ? [s] : [])))];
  const clean = { description: b.description || '', automate: b.automate || '', systems };
  if ('name' in b || JSON.stringify(systems) !== JSON.stringify(b.systems || [])) await db.setSetting('business', clean);
  return clean;
}

// Older versions stored API connections ({ status, config, account } + tokens in the
// vault). A system is now connected iff a row exists; keep only what maps to a system.
async function migrateConnections() {
  const rows = await db.all('connections');
  const legacy = rows.filter((r) => 'config' in r || 'status' in r || 'lastTest' in r);
  if (!legacy.length) return;
  const at = now();
  for (const r of legacy) {
    await db.delete('connections', r.id);
    const cfg = r.config || {};
    const add = [];
    if (r.id === 'google') add.push(...['gmail', 'google_calendar', 'google_drive', 'google_sheets'].map((id) => ({ id })));
    else if (r.id === 'salesforce' && /^https:\/\//.test(cfg.instanceUrl || '')) add.push({ id: 'salesforce', url: cfg.instanceUrl });
    else if (r.id === 'zendesk' && /^[a-z0-9-]+$/i.test(cfg.subdomain || '')) add.push({ id: 'zendesk', url: `https://${cfg.subdomain}.zendesk.com/agent` });
    else if (SYSTEMS[r.id] && !SYSTEMS[r.id].address) add.push({ id: r.id });
    for (const row of add) if (!(await db.get('connections', row.id))) await db.put('connections', { ...row, addedAt: r.connectedAt || at });
  }
}

// ---------------------------------------------------------------- tool executor
// Browser work happens in a working tab the extension opens and drives.
export const executor = createToolExecutor({
  db,
  getConnections: () => app.getConnections(),
  browser: {
    async open(url) {
      if (!bridge.paired) throw new Error(EXTENSION_REQUIRED);
      try {
        return await bridge.openTab(url, { active: false });
      } catch (e) {
        if (e.code === 'no_host_permission') throw new Error(`The WorkForge extension has no site access to ${hostOf(url) || url}. Open Systems and click “Grant site access”.`);
        throw e;
      }
    },
    async exec(action, args, { task }) {
      if (!bridge.paired) throw new Error(EXTENSION_REQUIRED);
      if (!task?.browser?.tabId) throw new Error('No working tab — call browser_open first.');
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
  getConnections: () => app.getConnections(),
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
  vault.onChange(() => {
    if (!vault.locked && app.isLeader) runtime.recover();
    if (bridge.paired) syncExtension().catch(() => {});
  });

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
// Nothing secret is synced except the AI key, and only when the owner allows it.
export async function syncExtension() {
  if (!bridge.paired) throw new Error('Extension not connected');
  const [employees, memory, collections, files, connections] = await Promise.all([
    db.all('employees'), db.all('memory'), db.all('collections'), db.all('files'), db.all('connections'),
  ]);
  const granted = new Set(employees.flatMap((e) => e.collections || []));
  const chunks = [];
  for (const cid of granted) chunks.push(...(await db.byIndex('chunks', 'collectionId', cid)));
  const snapshot = {
    employees, memory, collections, files: files.filter((f) => granted.has(f.collectionId)).map(({ dataUrl, ...f }) => f), chunks,
    connections: connections.map(({ id, url, custom, name, description, addedAt }) => ({ id, url, custom, name, description, addedAt })),
    business: app.business, settings: { approveAllOutbound: app.settings.approveAllOutbound },
    appUrl: location.origin + location.pathname,
    syncedAt: now(),
  };
  if (app.settings.shareAiKeyWithExtension && !vault.locked) {
    const ai = await app.getAI();
    if (ai.provider && ai.model) snapshot.ai = ai;
  }
  const r = await bridge.sync(snapshot);
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
