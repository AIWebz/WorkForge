// Shared utilities used by the WorkForce web app and the browser extension.

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const now = () => Date.now();

export const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function slug(s, fallback = 'item') {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return out || fallback;
}

export function truncate(s, n = 400) {
  const str = typeof s === 'string' ? s : safeStringify(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export function safeStringify(v, space) {
  try {
    return JSON.stringify(v, null, space);
  } catch {
    return String(v);
  }
}

// Extract the first JSON object/array from model output (handles ```json fences and prose).
export function extractJSON(text) {
  if (!text) throw new Error('Empty response from AI engine');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const start = c.search(/[{[]/);
    if (start === -1) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('AI engine did not return valid JSON');
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const STOP = new Set('the a an and or of to in on for with is are was were be by at as it this that from your you our we i me my can will should would could have has had not no do does did if then else when what which who how why all any each into out up about over under than so such also just only'.split(' '));

export function chunkText(text, size = 1200, overlap = 150) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) {
      const para = clean.lastIndexOf('\n', end);
      const sentence = clean.lastIndexOf('. ', end);
      const cut = Math.max(para, sentence);
      if (cut > i + size * 0.5) end = cut + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks.filter(Boolean);
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Base64url encode a UTF-8 string (used for Gmail raw messages).
export function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class Emitter {
  constructor() { this.handlers = new Set(); }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  emit(evt) { for (const h of [...this.handlers]) { try { h(evt); } catch (e) { console.error(e); } } }
}
