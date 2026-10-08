// Credential vault. Secrets (AI keys, API tokens) never live in source code or
// IndexedDB in plain text. Three storage modes:
//  - session:   sessionStorage, cleared when the tab closes (default)
//  - encrypted: AES-GCM ciphertext in localStorage, key derived from a passphrase (PBKDF2)
//  - device:    plain localStorage on this device (convenient, least secure)
const MODE_KEY = 'wf.vault.mode';
const ENC_KEY = 'wf.vault.enc';
const SESSION_KEY = 'wf.vault.session';
const DEVICE_KEY = 'wf.vault.device';
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

class Vault {
  constructor() {
    this.mode = localStorage.getItem(MODE_KEY) || 'session';
    this.data = null;
    this.key = null;
    this.salt = null;
    this.listeners = new Set();
    if (this.mode === 'session') this.data = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
    if (this.mode === 'device') this.data = JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}');
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { this.listeners.forEach((f) => f(this)); }

  get locked() { return this.data === null; }
  get hasEncrypted() { return !!localStorage.getItem(ENC_KEY); }

  async unlock(passphrase) {
    const blob = JSON.parse(localStorage.getItem(ENC_KEY) || 'null');
    if (!blob) {
      this.salt = crypto.getRandomValues(new Uint8Array(16));
      this.key = await deriveKey(passphrase, this.salt);
      this.data = {};
      await this.persist();
      this.notify();
      return;
    }
    const salt = unb64(blob.salt);
    const key = await deriveKey(passphrase, salt);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
      this.data = JSON.parse(dec.decode(plain));
      this.key = key;
      this.salt = salt;
      this.notify();
    } catch {
      throw new Error('Incorrect passphrase');
    }
  }

  lock() {
    if (this.mode !== 'encrypted') return;
    this.data = null;
    this.key = null;
    this.notify();
  }

  async persist() {
    if (this.mode === 'session') sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.data));
    else if (this.mode === 'device') localStorage.setItem(DEVICE_KEY, JSON.stringify(this.data));
    else {
      if (!this.key) throw new Error('Vault is locked');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(this.data)));
      localStorage.setItem(ENC_KEY, JSON.stringify({ salt: b64(this.salt), iv: b64(iv), ct: b64(ct), v: 1 }));
    }
  }

  get(name) { return this.data ? this.data[name] : undefined; }
  getAll() { return this.data ? { ...this.data } : null; }

  async set(name, value) {
    if (this.locked) throw new Error('Unlock the credential vault first (Settings → Security)');
    if (value === undefined || value === null || value === '') delete this.data[name];
    else this.data[name] = value;
    await this.persist();
    this.notify();
  }

  async remove(name) { return this.set(name, undefined); }

  /** Switch storage mode, migrating current secrets. */
  async setMode(mode, passphrase) {
    if (this.locked) throw new Error('Unlock the vault before changing its mode');
    const current = { ...this.data };
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem(ENC_KEY);
    this.mode = mode;
    localStorage.setItem(MODE_KEY, mode);
    this.data = current;
    if (mode === 'encrypted') {
      if (!passphrase || passphrase.length < 8) throw new Error('Choose a passphrase of at least 8 characters');
      this.salt = crypto.getRandomValues(new Uint8Array(16));
      this.key = await deriveKey(passphrase, this.salt);
    }
    await this.persist();
    this.notify();
  }

  async wipe() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem(ENC_KEY);
    localStorage.removeItem(MODE_KEY);
    this.mode = 'session';
    this.data = {};
    this.key = null;
    this.notify();
  }
}

export const vault = new Vault();
