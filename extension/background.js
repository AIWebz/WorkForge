// WorkForge extension background worker: pairing, data sync with the web app,
// site-access checks, and working tabs / browser actions for tasks started from
// the app. There is no API relay: employees work inside web apps in the user's
// own signed-in browser. Only paired origins are served.
import { DB } from './core/db.js';
import { runBrowserAction, openWorkingTab } from './browser-tools.js';

const db = new DB('workforge-ext');
const VERSION = chrome.runtime.getManifest().version;

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => restoreCustomOrigins());
chrome.runtime.onStartup.addListener(() => restoreCustomOrigins());

async function paired() {
  return (await chrome.storage.local.get('pairedOrigins')).pairedOrigins || [];
}

class BridgeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.channel === 'wf-bridge') {
    if (sender.id !== chrome.runtime.id) return false;
    handleBridge(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
    return true;
  }
  if (msg?.channel === 'wf-internal' && msg.type === 'registerOrigin') {
    registerOrigin(msg.origin).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function handleBridge({ type, payload = {} }, sender) {
  const origin = sender.origin || (sender.tab?.url ? new URL(sender.tab.url).origin : '');
  if (!origin) throw new BridgeError('Unknown origin');
  const list = await paired();
  const isPaired = list.includes(origin);

  if (type === 'hello') {
    return { version: VERSION, paired: isPaired };
  }
  if (type === 'pair') {
    if (isPaired) return { paired: true };
    await chrome.windows.create({ url: chrome.runtime.getURL(`pair.html?mode=pair&origin=${encodeURIComponent(origin)}`), type: 'popup', width: 460, height: 560 });
    return { paired: false, pending: true };
  }
  if (!isPaired) throw new BridgeError('This WorkForge app is not connected to the extension. Click “Connect extension” on the Browser Extension page.', 'not_paired');

  switch (type) {
    case 'unpair':
      await chrome.storage.local.set({ pairedOrigins: list.filter((o) => o !== origin) });
      return { paired: false };
    case 'sync': return sync(payload, origin);
    case 'pull': return pull(payload.since || 0);
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => /^https?:/.test(t.url || '') && !t.url.startsWith(origin)).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case 'grantHosts': {
      const origins = validOrigins(payload.origins);
      if (!origins.length) return { granted: true };
      if (await chrome.permissions.contains({ origins })) return { granted: true };
      await chrome.windows.create({ url: chrome.runtime.getURL(`pair.html?mode=grant&origins=${encodeURIComponent(JSON.stringify(origins))}`), type: 'popup', width: 460, height: 520 });
      return { granted: false, pending: true };
    }
    case 'checkHosts': {
      const granted = {};
      for (const o of Array.isArray(payload.origins) ? payload.origins : []) {
        const key = String(o);
        const pat = toPattern(key);
        granted[key] = false;
        if (!pat) continue;
        try { granted[key] = await chrome.permissions.contains({ origins: [pat] }); } catch { granted[key] = false; }
      }
      return { granted };
    }
    case 'openTab': {
      let u;
      try { u = new URL(String(payload.url || '')); } catch { throw new BridgeError('Invalid address for the working tab.', 'invalid_url'); }
      if (!/^https?:$/.test(u.protocol)) throw new BridgeError('Only http(s) pages can be opened.', 'invalid_url');
      if (!(await chrome.permissions.contains({ origins: [`${u.origin}/*`] }))) {
        throw new BridgeError(`The extension has no access to ${u.host}. Allow it from the app's Systems page or the WorkForge side panel.`, 'no_host_permission');
      }
      return openWorkingTab(u.href, { active: !!payload.active });
    }
    case 'browser': return runBrowserAction(Number(payload.tabId), payload.action, payload.args || {});
    default: throw new BridgeError(`Unknown request ${type}`);
  }
}

// Host permission patterns the extension may request ("https://host/*", "https://*.host/*").
// A bare origin or URL ("https://host") is turned into its "https://host/*" pattern.
function toPattern(o) {
  const s = String(o || '').trim();
  if (s === 'https://*/*' || s === 'http://*/*') return s;
  if (/^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?\/\*$/i.test(s)) return s;
  try { const u = new URL(s); if (/^https?:$/.test(u.protocol)) return `${u.origin}/*`; } catch { /* invalid */ }
  return '';
}
function validOrigins(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(toPattern).filter(Boolean))];
}

async function sync(snap, origin) {
  const { lastPullAt = 0 } = await chrome.storage.local.get('lastPullAt');
  // Replace configuration stores with the app's snapshot. Connections carry only
  // which systems are connected and their addresses — strip anything else.
  const connections = (snap.connections || []).filter((c) => c?.id)
    .map(({ id, url, custom, name, description, addedAt }) => JSON.parse(JSON.stringify({ id, url, custom, name, description, addedAt })));
  const stores = { employees: snap.employees, collections: snap.collections, files: snap.files, chunks: snap.chunks, connections };
  for (const [store, rows] of Object.entries(stores)) {
    await db.clear(store);
    if (rows?.length) await db.bulkPut(store, rows);
  }
  // Memory: upsert the app's copy; drop local items the app has already pulled but no longer has.
  const appIds = new Set((snap.memory || []).map((m) => m.id));
  for (const m of await db.all('memory')) if (!appIds.has(m.id) && m.createdAt < lastPullAt) await db.delete('memory', m.id);
  if (snap.memory?.length) await db.bulkPut('memory', snap.memory);
  await chrome.storage.local.set({ business: snap.business || null, settings: snap.settings || {}, appOrigin: origin, appUrl: snap.appUrl && snap.appUrl.startsWith(origin) ? snap.appUrl : `${origin}/`, lastSyncAt: Date.now() });
  // Model choice for the local AI engine (not a secret). Self-hosted weights are fetched from the app's site.
  if (snap.ai?.model) await chrome.storage.local.set({ ai: { model: snap.ai.model, source: snap.ai.source?.base ? { base: snap.ai.source.base } : {} } });
  await chrome.storage.session.remove(['secrets', 'ai']).catch(() => {});
  return { ok: true, employees: snap.employees?.length || 0 };
}

async function pull(since) {
  const [tasks, approvals, activity, memory] = await Promise.all([db.all('tasks'), db.all('approvals'), db.all('activity'), db.all('memory')]);
  const now = Date.now();
  await chrome.storage.local.set({ lastPullAt: now });
  return {
    now,
    tasks: tasks.filter((t) => (t.completedAt || now) >= since || !['completed', 'failed', 'cancelled'].includes(t.status)),
    approvals: approvals.filter((a) => (a.resolvedAt || now) >= since),
    activity: activity.filter((a) => a.ts >= since),
    memory: memory.filter((m) => m.createdAt >= since && ['runtime', 'employee', 'human'].includes(m.source)),
  };
}

// Custom app domains (not *.github.io / localhost) get the bridge registered dynamically.
async function registerOrigin(origin) {
  const id = `wf-bridge-${origin.replace(/[^a-z0-9]/gi, '_')}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ['bridge.js'], runAt: 'document_start', persistAcrossSessions: true }]);
  const { customOrigins = [] } = await chrome.storage.local.get('customOrigins');
  if (!customOrigins.includes(origin)) await chrome.storage.local.set({ customOrigins: [...customOrigins, origin] });
}

async function restoreCustomOrigins() {
  const { customOrigins = [] } = await chrome.storage.local.get('customOrigins');
  for (const o of customOrigins) {
    if (await chrome.permissions.contains({ origins: [`${o}/*`] })) await registerOrigin(o).catch(() => {});
  }
}
