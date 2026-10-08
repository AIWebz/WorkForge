// UI helpers: escaping, icons, toasts, modals, drawers, formatting.
import { SYSTEMS, CONNECTIONS } from '../extension/core/catalog.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;

export function refreshIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons();
}
window.addEventListener('load', refreshIcons);

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

/** Delegate events: on(root, 'click', '[data-action=x]', (e, el) => …) */
export function on(root, type, selector, fn) {
  const h = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) fn(e, el);
  };
  root.addEventListener(type, h);
  return () => root.removeEventListener(type, h);
}

export function toast(message, type = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert-circle' : type === 'success' ? 'check-circle-2' : 'info')}<div>${esc(message)}</div>`;
  host.appendChild(el);
  refreshIcons();
  setTimeout(() => el.remove(), ms);
}

export function modal({ title, subtitle = '', body = '', actions = [], wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p class="muted small mt-4">${subtitle}</p>` : ''}</div>
    <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}" data-act="${i}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-close]').onclick = close;
  actions.forEach((a, i) => {
    const btn = wrap.querySelector(`[data-act="${i}"]`);
    btn.onclick = async () => {
      if (!a.onClick) return close();
      btn.disabled = true;
      try {
        const r = await a.onClick(wrap, close);
        if (r !== false) close();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };
  });
  root.appendChild(wrap);
  refreshIcons();
  onMount && onMount(wrap, close);
  const first = wrap.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { el: wrap, close };
}

export function confirmDialog(message, { title = 'Are you sure?', confirm = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p class="muted">${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: confirm, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function drawer({ title, subtitle = '', body = '', onMount }) {
  const root = document.getElementById('modal-root');
  const back = document.createElement('div');
  back.className = 'drawer-backdrop';
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.innerHTML = `<div class="drawer-head"><div class="grow"><h2>${esc(title)}</h2>${subtitle ? `<div class="muted small mt-4">${subtitle}</div>` : ''}</div><button class="icon-btn" data-close>${icon('x')}</button></div><div class="drawer-body">${body}</div>`;
  const close = () => { back.remove(); el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.onclick = close;
  el.querySelector('[data-close]').onclick = close;
  root.append(back, el);
  refreshIcons();
  onMount && onMount(el, close);
  return { el, close, setBody(html) { el.querySelector('.drawer-body').innerHTML = html; refreshIcons(); } };
}

// ---------------------------------------------------------- formatting
export function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return `in ${humanDelta(-s)}`;
  if (s < 10) return 'just now';
  return `${humanDelta(s)} ago`;
}
function humanDelta(s) {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
export function fmtHours(minutes) {
  if (!minutes) return '0h';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
}

const STATUS = {
  active: ['badge-success', 'Active'], working: ['badge-success badge-live', 'Working'], draft: ['', 'Draft'], paused: ['badge-warning', 'Paused'],
  queued: ['badge-info', 'Queued'], running: ['badge-primary badge-live', 'Running'], waiting_approval: ['badge-warning', 'Awaiting approval'],
  completed: ['badge-success', 'Completed'], failed: ['badge-danger', 'Failed'], cancelled: ['', 'Cancelled'], needs_attention: ['badge-danger', 'Needs attention'],
  pending: ['badge-warning', 'Pending'], approved: ['badge-success', 'Approved'], edited: ['badge-success', 'Edited & approved'], rejected: ['badge-danger', 'Rejected'], stale: ['', 'Stale'],
  connected: ['badge-success', 'Connected'], error: ['badge-danger', 'Error'], disconnected: ['', 'Not connected'], scheduled: ['badge-info', 'Scheduled'], done: ['badge-success', 'Done'],
  success: ['badge-success', 'Success'], info: ['', 'Info'], warning: ['badge-warning', 'Warning'], blocked: ['badge-danger', 'Blocked'], waiting: ['badge-warning', 'Waiting'],
};
export function statusBadge(status, label) {
  const [cls, text] = STATUS[status] || ['', status];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label || text)}</span>`;
}
export const statusColor = (s) => ({ success: 'var(--success)', error: 'var(--danger)', blocked: 'var(--danger)', rejected: 'var(--danger)', waiting: 'var(--warning)', warning: 'var(--warning)', running: 'var(--primary)', approved: 'var(--success)' }[s] || 'var(--faint)');

export function avatar(emp, size = '') {
  const c = emp?.avatar?.color || '#6366F1';
  return `<div class="avatar ${size}" style="background:${esc(c)}">${esc(emp?.avatar?.initials || '?')}</div>`;
}

export function sysIcon(id, small = false) {
  const s = SYSTEMS[id] || CONNECTIONS[id] || { color: '#94a3b8', glyph: '?' };
  return `<span class="sys-icon ${small ? 'sm' : ''}" style="background:${esc(s.color)}" title="${esc(s.name || id)}">${esc(s.glyph)}</span>`;
}

// Minimal, safe markdown (escape first, then format).
export function md(text) {
  const lines = esc(text || '').split('\n');
  let html = '';
  let inList = false;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1<em>$2</em>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) html += `<h4>${inline(h[2])}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return `<div class="md">${html}</div>`;
}

export function emptyState(ic, title, text, action = '') {
  return `<div class="empty"><div class="empty-icon">${icon(ic)}</div><h3>${esc(title)}</h3><p class="small" style="max-width:420px">${text}</p>${action}</div>`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const scriptCache = new Map();
export function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scriptCache.delete(src); reject(new Error(`Failed to load ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}
