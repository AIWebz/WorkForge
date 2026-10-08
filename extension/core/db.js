// IndexedDB persistence shared by the web app and the extension.
// Every write emits a change event (and broadcasts to other tabs) so the UI
// always reflects real application state.
import { Emitter } from './util.js';

const VERSION = 1;
const STORES = {
  employees: [],
  tasks: ['employeeId', 'status'],
  activity: ['employeeId', 'taskId'],
  approvals: ['employeeId', 'status'],
  memory: ['employeeId'],
  collections: [],
  files: ['collectionId'],
  chunks: ['fileId', 'collectionId'],
  connections: [],
  schedules: ['employeeId'],
  reports: [],
  versions: ['employeeId'],
  settings: [],
};

export class DB extends Emitter {
  constructor(name = 'workforge') {
    super();
    this.name = name;
    this.dbp = null;
    try {
      this.channel = new BroadcastChannel(`${name}-changes`);
      this.channel.onmessage = (e) => super.emit({ ...e.data, remote: true });
    } catch { this.channel = null; }
  }

  open() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [store, indexes] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(store)) continue;
          const os = db.createObjectStore(store, { keyPath: 'id' });
          for (const idx of indexes) os.createIndex(idx, idx, { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      Promise.resolve(fn(os)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async get(store, id) {
    if (id === undefined || id === null) return undefined;
    return this.tx(store, 'readonly', (os) => this.req(os.get(id)));
  }

  async all(store) {
    return this.tx(store, 'readonly', (os) => this.req(os.getAll()));
  }

  async byIndex(store, index, value) {
    return this.tx(store, 'readonly', (os) => this.req(os.index(index).getAll(value)));
  }

  async put(store, obj, { silent = false } = {}) {
    if (!obj || !obj.id) throw new Error(`Cannot save ${store} record without id`);
    await this.tx(store, 'readwrite', (os) => os.put(obj));
    if (!silent) this.emitChange({ store, op: 'put', id: obj.id });
    return obj;
  }

  async bulkPut(store, arr) {
    if (!arr.length) return;
    await this.tx(store, 'readwrite', (os) => arr.forEach((o) => os.put(o)));
    this.emitChange({ store, op: 'bulk', count: arr.length });
  }

  async delete(store, id) {
    await this.tx(store, 'readwrite', (os) => os.delete(id));
    this.emitChange({ store, op: 'delete', id });
  }

  async deleteWhere(store, index, value) {
    const rows = await this.byIndex(store, index, value);
    if (!rows.length) return 0;
    await this.tx(store, 'readwrite', (os) => rows.forEach((r) => os.delete(r.id)));
    this.emitChange({ store, op: 'bulk-delete', count: rows.length });
    return rows.length;
  }

  async clear(store) {
    await this.tx(store, 'readwrite', (os) => os.clear());
    this.emitChange({ store, op: 'clear' });
  }

  async getSetting(key, fallback) {
    const row = await this.get('settings', key);
    return row ? row.value : fallback;
  }

  async setSetting(key, value) {
    return this.put('settings', { id: key, value });
  }

  emitChange(evt) {
    this.emit(evt);
    try { this.channel && this.channel.postMessage(evt); } catch { /* ignore */ }
  }
}

export const STORE_NAMES = Object.keys(STORES);
