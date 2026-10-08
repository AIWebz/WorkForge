// Page-side bridge to the WorkForge browser extension. The extension's content
// script (extension/bridge.js) relays these messages to its background worker,
// which only serves origins the user explicitly paired. Employees work inside
// systems (web apps) in browser tabs the extension opens with the owner's own
// signed-in session; site access is granted per system.
import { Emitter, uid } from '../extension/core/util.js';

class Bridge extends Emitter {
  constructor() {
    super();
    this.available = false;
    this.paired = false;
    this.version = null;
    this.pending = new Map();
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.__wf !== 'response') {
        if (e.source === window && e.data?.__wf === 'ext-ready') this.detect();
        return;
      }
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(e.data.data);
      else {
        if (e.data.code === 'not_paired' && this.paired) { this.paired = false; this.emit({ type: 'status' }); }
        const err = new Error(e.data.error || 'Extension request failed');
        if (e.data.code) err.code = e.data.code;
        p.reject(err);
      }
    });
  }

  request(type, payload = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = uid('br');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(type === 'hello' ? 'Extension not detected' : `Extension did not respond (${type})`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      window.postMessage({ __wf: 'request', id, type, payload }, window.location.origin);
    });
  }

  async detect() {
    const before = `${this.available}/${this.paired}`;
    try {
      const r = await this.request('hello', {}, 1500);
      this.available = true;
      this.paired = !!r.paired;
      this.version = r.version;
      this.permissions = r.permissions || {};
    } catch {
      this.available = false;
      this.paired = false;
    }
    if (before !== `${this.available}/${this.paired}`) this.emit({ type: 'status' });
    return this;
  }

  // Opens an approval window in the extension; resolves once the user allows it.
  async pair() {
    const r = await this.request('pair', {}, 10000);
    if (!r.paired) {
      const until = Date.now() + 180000;
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, 1500));
        await this.detect();
        if (this.paired) break;
      }
    } else this.paired = true;
    this.emit({ type: 'status' });
    return { paired: this.paired };
  }

  async unpair() {
    await this.request('unpair', {});
    this.paired = false;
    this.emit({ type: 'status' });
  }

  sync(snapshot) { return this.request('sync', snapshot, 30000); }
  pull(since) { return this.request('pull', { since }, 20000); }
  tabs() { return this.request('tabs', {}, 8000); }
  // Asks the extension for site access ("https://host/*" origins). Resolves
  // { granted: true } or { granted: false, pending: true } while a grant window is open.
  grantHosts(origins) { return this.request('grantHosts', { origins }, 180000); }

  // → { granted: { [origin]: boolean } }
  checkHosts(origins) { return this.request('checkHosts', { origins }, 8000); }

  // Opens a working tab → { tabId, url, title }. Rejects with code 'no_host_permission'
  // when the site has not been granted.
  openTab(url, { active = false } = {}) { return this.request('openTab', { url, active }, 45000); }

  browserAction(tabId, action, args) {
    return this.request('browser', { tabId, action, args }, 60000);
  }
}

export const bridge = new Bridge();
