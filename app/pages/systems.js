// Systems: the web apps employees work in. A system is connected when a row
// exists in the `connections` store. There are no tokens or keys: employees use
// the owner's own signed-in browser session through the WorkForge extension,
// which needs site access to each system (checked live, granted per system).
import { esc, icon, sysIcon, toast, modal, confirmDialog, emptyState, refreshIcons, statusBadge } from '../ui.js';
import { SYSTEMS, SYSTEM_GROUPS, allSystems, hostOf, systemOrigins, systemUrl, systemForUrl } from '../../extension/core/catalog.js';
import { now } from '../../extension/core/util.js';
import { bridge } from '../bridge.js';

const hostsOf = (origins) => origins.map((o) => o.replace(/^https:\/\//, '').replace(/\/\*$/, ''));

function hostMatches(pattern, host) {
  const hostPat = pattern.split('/')[0].toLowerCase();
  if (hostPat.startsWith('*.')) { const base = hostPat.slice(2); return host === base || host.endsWith(`.${base}`); }
  return host === hostPat;
}

/**
 * Validates the address a user entered for a system that needs one.
 * Must be https and (unless the system accepts any host, like WordPress) match
 * the system's host patterns. Returns the normalized URL.
 */
export function validateSystemAddress(systemId, value) {
  const sys = SYSTEMS[systemId];
  let raw = String(value || '').trim();
  if (!raw) throw new Error(`Enter ${sys?.address?.label?.toLowerCase() || 'the address'}`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid web address'); }
  if (u.protocol !== 'https:') throw new Error('The address must start with https://');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) throw new Error('Enter the full address, e.g. https://example.com');
  const patterns = sys?.match || [];
  if (patterns.length && !patterns.some((p) => hostMatches(p, host))) {
    throw new Error(`${sys.name} addresses look like ${patterns.map((p) => p.split('/')[0]).join(' or ')}`);
  }
  u.hash = '';
  return u.href;
}

/** Asks the extension for site access to a system. Returns 'granted' | 'pending' | 'no-extension'. */
export async function grantSiteAccess(app, systemId) {
  if (!bridge.paired) return 'no-extension';
  const rows = await app.getConnections();
  const origins = systemOrigins(systemId, rows);
  if (!origins.length) return 'granted';
  const r = await bridge.grantHosts(origins);
  return r?.granted ? 'granted' : 'pending';
}

function accessToast(name, result, verb = 'connected') {
  if (result === 'granted') toast(`${name} ${verb} · site access granted`, 'success');
  else if (result === 'pending') toast(`${name} ${verb} — approve site access in the extension window`, 'info', 7000);
  else toast(`${name} ${verb}. Install and connect the browser extension so employees can work in it.`, 'info', 7000);
}

function extensionNote(name, hosts) {
  const list = hosts.length ? hosts.map((h) => `<code>${esc(h)}</code>`).join(', ') : '';
  if (bridge.paired) return `<div class="callout success">${icon('puzzle')}<div class="small">Extension connected. After you continue, your browser asks to allow WorkForge on ${list || 'this site'}.</div></div>`;
  if (bridge.available) return `<div class="callout warn">${icon('puzzle')}<div class="small">The extension is installed but not connected to this workspace. <a href="#/extension">Connect it</a>, then grant site access to ${esc(name)} from this page.</div></div>`;
  return `<div class="callout warn">${icon('puzzle')}<div class="small">Employees need the WorkForge browser extension to work in ${esc(name)}. You can add it now and <a href="#/extension">install the extension</a> afterwards.</div></div>`;
}

/** Connect (or edit) a system. Asks only for the address when the system needs one. */
export async function openConnectDialog(app, systemId) {
  const rows = await app.getConnections();
  const existing = rows.find((r) => r.id === systemId) || null;
  const sys = allSystems(rows)[systemId];
  if (!sys) return toast('Unknown system', 'error');
  const custom = !!sys.custom;
  const origins = systemOrigins(systemId, rows);
  modal({
    title: existing ? sys.name : `Connect ${sys.name}`,
    subtitle: esc(sys.description || ''),
    body: `<div class="form-grid">
      <div class="row-top">${sysIcon(systemId, false, sys.name)}<p class="small muted">Your employee works in ${esc(sys.name)} in a browser tab, signed in with <strong>your own login</strong> — the way you would. WorkForge never asks for your password, and nothing is stored besides ${sys.address || custom ? 'the address below' : 'the fact that it is connected'}. Clicking and typing start as approval-required.</p></div>
      ${custom ? `<label class="field"><span>Name</span><input class="input" data-f="name" value="${esc(existing?.name || sys.name)}" maxlength="60"></label>
        <label class="field"><span>Address</span><input class="input" data-f="url" value="${esc(existing?.url || '')}" placeholder="https://app.example.com" inputmode="url"></label>` : ''}
      ${sys.address ? `<label class="field"><span>${esc(sys.address.label)}</span><input class="input" data-f="url" value="${esc(existing?.url || '')}" placeholder="${esc(sys.address.placeholder || 'https://')}" inputmode="url" autocomplete="url"><span class="help">The address you open ${esc(sys.name)} at, so employees go to your account.</span></label>` : ''}
      ${!sys.address && !custom ? `<p class="help">Employees open ${esc(sys.name)} at <code>${esc(systemUrl(systemId, rows))}</code>. Sign in there in this browser before they start.</p>` : ''}
      ${extensionNote(sys.name, sys.address && !existing ? [] : hostsOf(origins))}
    </div>`,
    actions: [
      ...(existing ? [{ label: 'Remove', danger: true, onClick: async () => removeSystem(app, systemId) }] : []),
      { label: 'Cancel' },
      { label: existing ? 'Save' : 'Connect', primary: true, icon: 'plug', onClick: async (m) => {
        const row = { ...(existing || {}), id: systemId, addedAt: existing?.addedAt || now() };
        if (custom) {
          const name = m.querySelector('[data-f="name"]').value.trim();
          if (!name) throw new Error('Give the web app a name');
          const url = validateCustomUrl(m.querySelector('[data-f="url"]').value, rows, systemId);
          Object.assign(row, { custom: true, name, url });
        } else if (sys.address) {
          row.url = validateSystemAddress(systemId, m.querySelector('[data-f="url"]').value);
        }
        await app.db.put('connections', row);
        let result = 'no-extension';
        try { result = await grantSiteAccess(app, systemId); } catch (e) { toast(`Site access: ${e.message}`, 'error'); }
        accessToast(row.name || sys.name, result, existing ? 'saved' : 'connected');
      } },
    ],
  });
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'app';
}

function validateCustomUrl(value, rows, selfId = '') {
  let raw = String(value || '').trim();
  if (!raw) throw new Error('Enter the web app address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid web address'); }
  if (u.protocol !== 'https:') throw new Error('The address must start with https://');
  if (!u.hostname.includes('.')) throw new Error('Enter the full address, e.g. https://app.example.com');
  if (u.origin === location.origin) throw new Error('That is the WorkForge app itself');
  const owner = systemForUrl(u.href, rows.filter((r) => r.id !== selfId));
  if (owner) {
    const name = allSystems(rows)[owner]?.name || owner;
    throw new Error(SYSTEMS[owner] ? `That address belongs to ${name} — connect ${name} from the catalog instead.` : `That address is already added as ${name}.`);
  }
  u.hash = '';
  return u.href;
}

function openCustomDialog(app) {
  modal({
    title: 'Add a custom web app',
    subtitle: 'Any web app you use in this browser — an admin panel, a portal, an internal tool.',
    body: `<div class="form-grid">
      <label class="field"><span>Name</span><input class="input" id="c-name" maxlength="60" placeholder="e.g. Partner portal"></label>
      <label class="field"><span>Address</span><input class="input" id="c-url" placeholder="https://portal.example.com" inputmode="url"><span class="help">Employees open this address and work there with your own login. Only this site (host) is granted.</span></label>
      ${extensionNote('this web app', [])}
    </div>`,
    actions: [
      { label: 'Cancel' },
      { label: 'Add web app', primary: true, icon: 'plus', onClick: async (m) => {
        const rows = await app.getConnections();
        const name = m.querySelector('#c-name').value.trim();
        if (!name) throw new Error('Give the web app a name');
        const url = validateCustomUrl(m.querySelector('#c-url').value, rows);
        const base = `custom_${slugify(name)}`;
        const taken = new Set([...rows.map((r) => r.id), ...Object.keys(SYSTEMS)]);
        let id = base;
        for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
        await app.db.put('connections', { id, custom: true, name, url, addedAt: now() });
        let result = 'no-extension';
        try { result = await grantSiteAccess(app, id); } catch (e) { toast(`Site access: ${e.message}`, 'error'); }
        accessToast(name, result, 'added');
      } },
    ],
  });
}

async function removeSystem(app, id) {
  const [rows, employees] = await Promise.all([app.getConnections(), app.db.all('employees')]);
  const name = allSystems(rows)[id]?.name || id;
  const users = employees.filter((e) => (e.systems || []).includes(id) || e.permissions?.[id]).map((e) => e.name);
  const msg = `Remove ${name}?${users.length ? ` ${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} it and will not be able to work there until you connect it again.` : ''} Site access the extension already has stays until you remove it in chrome://extensions.`;
  if (!(await confirmDialog(msg, { danger: true, confirm: 'Remove' }))) return false;
  await app.db.delete('connections', id);
  toast(`${name} removed`);
  return true;
}

// ------------------------------------------------------------ system picker
// Tiles for choosing which systems a business uses (onboarding, settings).
const POPULAR = ['gmail', 'outlook', 'google_calendar', 'google_sheets', 'slack', 'microsoft_teams', 'hubspot', 'salesforce', 'shopify', 'zendesk', 'notion', 'linkedin'];

export function systemPickerHtml(selected = [], { connections = [], limit = 12 } = {}) {
  const all = allSystems(connections);
  const order = [...new Set([...selected.filter((id) => all[id]), ...POPULAR, ...Object.keys(all)])];
  const sel = new Set(selected);
  return `<div class="tiles" data-picker>${order.map((id, i) => {
    const s = all[id];
    const extra = i >= limit;
    return `<button type="button" class="tile ${sel.has(id) ? 'selected' : ''}" data-pick="${esc(id)}" aria-pressed="${sel.has(id)}" ${extra ? 'data-extra' : ''} ${extra && !sel.has(id) ? 'hidden' : ''}>${sysIcon(id, false, s.name)}<div class="grow" style="min-width:0"><div class="ellipsis">${esc(s.name)}</div><div class="tile-sub ellipsis">${esc(s.custom ? 'Custom' : s.group)}</div></div></button>`;
  }).join('')}</div>${order.length > limit ? `<button type="button" class="link-btn mt-8" data-pick-more data-count="${order.length}">${icon('chevron-down')} Show all ${order.length} systems</button>` : ''}`;
}

/** Binds tiles rendered by systemPickerHtml; `selected` is a Set that is kept up to date. */
export function bindSystemPicker(root, selected, onChange = () => {}) {
  let open = false;
  root.querySelectorAll('[data-pick]').forEach((t) => t.addEventListener('click', () => {
    const id = t.dataset.pick;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    t.classList.toggle('selected', selected.has(id));
    t.setAttribute('aria-pressed', String(selected.has(id)));
    onChange(selected);
  }));
  const more = root.querySelector('[data-pick-more]');
  more?.addEventListener('click', () => {
    open = !open;
    root.querySelectorAll('[data-pick][data-extra]').forEach((t) => { t.hidden = !open && !selected.has(t.dataset.pick); });
    more.innerHTML = open ? `${icon('chevron-up')} Show fewer` : `${icon('chevron-down')} Show all ${more.dataset.count} systems`;
    refreshIcons();
  });
}

// ------------------------------------------------------------ page
export default async function systemsPage(ctx) {
  const { el, app } = ctx;
  const wantsCatalog = location.hash.startsWith('#/integrations');
  el.innerHTML = '<div class="page" id="sp"></div>';
  const page = el.querySelector('#sp');
  let filter = '';
  let first = true;

  const render = async () => {
    if (!ctx.isCurrent()) return;
    await bridge.detect();
    const [rows, employees, aiReady] = await Promise.all([app.getConnections(), app.db.all('employees'), app.aiReady()]);
    const all = allSystems(rows);
    const connected = rows.filter((r) => all[r.id]).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const usedBy = (id) => employees.filter((e) => (e.systems || []).includes(id) || e.permissions?.[id]);
    const originsById = Object.fromEntries(connected.map((r) => [r.id, systemOrigins(r.id, rows)]));

    // Live site-access status from the extension.
    let granted = null;
    if (bridge.paired) {
      const list = [...new Set(Object.values(originsById).flat())];
      try { granted = list.length ? (await bridge.checkHosts(list)).granted || {} : {}; } catch { granted = null; }
    }
    const access = (id) => {
      if (!bridge.paired || !granted) return 'unknown';
      const o = originsById[id] || [];
      return o.length && o.every((x) => granted[x]) ? 'granted' : 'missing';
    };
    const grantedCount = connected.filter((r) => access(r.id) === 'granted').length;
    const extLabel = bridge.paired ? 'Connected' : bridge.available ? 'Not connected' : 'Not installed';
    const accessCell = (id) => {
      const a = access(id);
      if (a === 'granted') return statusBadge('connected', 'Site access granted');
      if (a === 'missing') return `<div class="row gap-6 wrap">${statusBadge('pending', 'Needs site access')}<button class="btn btn-xs btn-primary" data-grant="${esc(id)}">${icon('shield-check')} Grant site access</button></div>`;
      if (bridge.paired) return '<span class="small muted">Could not check</span>';
      return `<a class="small" href="#/extension">${bridge.available ? 'Connect the extension' : 'Install the extension'}</a>`;
    };
    const address = (r) => {
      const url = systemUrl(r.id, rows);
      if (!url) return '<span class="small s-err">Address missing</span>';
      return `<span class="small mono ellipsis" title="${esc(url)}" style="display:block;max-width:260px">${esc(url.replace(/^https:\/\//, '').replace(/\/$/, ''))}</span>`;
    };

    const groups = [...SYSTEM_GROUPS];
    const q = filter.toLowerCase();
    const catalogCard = (id, s) => {
      const conn = rows.some((r) => r.id === id);
      const hay = `${s.name} ${s.group} ${s.description}`.toLowerCase();
      return `<div class="int-card" data-card="${esc(id)}" data-hay="${esc(hay)}" ${q && !hay.includes(q) ? 'hidden' : ''}>
        <div class="between"><div class="row">${sysIcon(id, false, s.name)}<div><div class="strong">${esc(s.name)}</div>${s.address ? '<div class="tiny muted">Uses your own address</div>' : `<div class="tiny muted">${esc(hostOf(s.url))}</div>`}</div></div>${conn ? statusBadge('connected', 'Connected') : ''}</div>
        <p class="small muted">${esc(s.description)}</p>
        <div class="row" style="justify-content:flex-end"><button class="btn btn-sm ${conn ? '' : 'btn-primary'}" data-connect="${esc(id)}">${conn ? 'Manage' : `${icon('plus')} Connect`}</button></div>
      </div>`;
    };

    page.innerHTML = `<div class="page-head"><div><h1>Systems</h1><p>The web apps your employees work in. They work in browser tabs with your own signed-in session through the WorkForge extension — no passwords, tokens or keys are stored.</p></div>
      <div class="row"><button class="btn" id="add-custom">${icon('globe')} Add custom web app</button><a class="btn btn-primary" href="#/systems" id="to-catalog">${icon('plus')} Connect a system</a></div></div>
      <div class="stats mb-16">
        <div class="stat"><div class="stat-top">Connected systems</div><div class="stat-value">${connected.length}</div></div>
        <div class="stat"><div class="stat-top">Site access granted</div><div class="stat-value">${bridge.paired && granted ? `${grantedCount}/${connected.length}` : '—'}</div></div>
        <div class="stat"><div class="stat-top">Browser extension</div><div class="stat-value" style="font-size:16px">${extLabel}</div><div class="stat-sub small muted">${bridge.paired ? `v${esc(bridge.version || '')}` : '<a href="#/extension">Set it up</a>'}</div></div>
        <div class="stat"><div class="stat-top">AI engine</div><div class="stat-value" style="font-size:16px">${aiReady ? 'Ready' : 'Not configured'}</div></div>
      </div>
      ${!bridge.paired && connected.length ? `<div class="callout warn mb-16">${icon('puzzle')}<div class="small">Employees work in these systems through the WorkForge browser extension. ${bridge.available ? 'It is installed — <a href="#/extension">connect it to this workspace</a>.' : '<a href="#/extension">Install the extension</a> to let them start.'}</div></div>` : ''}

      <div class="section-title between mb-8"><h3>Connected</h3><span class="small muted">${connected.length ? 'Sign in to each system in this browser so employees can use your session.' : ''}</span></div>
      ${connected.length ? `<div class="card mb-16"><div class="table-wrap"><table class="log-table"><thead><tr><th>System</th><th>Address</th><th>Used by</th><th>Site access</th><th></th></tr></thead><tbody>
        ${connected.map((r) => {
    const s = all[r.id];
    const users = usedBy(r.id);
    const url = systemUrl(r.id, rows);
    return `<tr><td><div class="row">${sysIcon(r.id, false, s.name)}<div><div class="strong small">${esc(s.name)}</div><div class="tiny muted">${esc(s.custom ? 'Custom web app' : s.group)}</div></div></div></td>
          <td>${address(r)}</td>
          <td class="small">${users.length ? users.map((e) => `<a href="#/employees/${esc(e.id)}">${esc(e.name)}</a>`).join(', ') : '<span class="muted">—</span>'}</td>
          <td>${accessCell(r.id)}</td>
          <td><div class="row gap-6" style="justify-content:flex-end">${url ? `<a class="btn btn-xs" href="${esc(url)}" target="_blank" rel="noopener">${icon('external-link')} Open</a>` : ''}<button class="btn btn-xs" data-connect="${esc(r.id)}">${icon('pencil')} Edit</button><button class="btn btn-xs btn-ghost" data-remove="${esc(r.id)}" title="Remove">${icon('trash-2')} Remove</button></div></td></tr>`;
  }).join('')}
      </tbody></table></div></div>` : `<div class="card mb-16">${emptyState('app-window', 'No systems connected yet', 'Pick the web apps your business runs on from the catalog below. Employees will work in them in browser tabs, signed in as you.')}</div>`}

      <div class="between mt-24 mb-8" id="catalog"><h3>Catalog</h3><div class="input-icon" style="max-width:260px">${icon('search')}<input class="input" id="cat-search" placeholder="Search systems" value="${esc(filter)}"></div></div>
      ${groups.map((g) => {
    const list = Object.entries(SYSTEMS).filter(([, s]) => s.group === g);
    if (!list.length) return '';
    return `<div data-group><h4 class="small muted mb-8 mt-16" style="text-transform:uppercase;letter-spacing:.06em">${esc(g)}</h4><div class="grid-3">${list.map(([id, s]) => catalogCard(id, s)).join('')}</div></div>`;
  }).join('')}
      <div data-group><h4 class="small muted mb-8 mt-16" style="text-transform:uppercase;letter-spacing:.06em">Your own</h4><div class="grid-3">
        ${rows.filter((r) => r.custom && all[r.id]).map((r) => catalogCard(r.id, all[r.id])).join('')}
        <div class="int-card" data-card="custom" data-hay="custom web app other website portal admin"><div class="row">${sysIcon('web')}<div class="strong">Custom web app</div></div><p class="small muted">Any other web app you sign in to — an admin panel, a supplier portal, an internal tool.</p><div class="row" style="justify-content:flex-end"><button class="btn btn-sm" data-add-custom>${icon('plus')} Add</button></div></div>
        <div class="int-card" data-card="files" data-hay="knowledge files documents pdf"><div class="row">${sysIcon('files')}<div class="strong">Knowledge files</div></div><p class="small muted">Documents employees can search and read, stored only in this browser.</p><div class="row" style="justify-content:flex-end"><a class="btn btn-sm" href="#/files">Manage files</a></div></div>
      </div></div>`;

    page.querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => openConnectDialog(app, b.dataset.connect));
    page.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => removeSystem(app, b.dataset.remove));
    page.querySelectorAll('[data-grant]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await grantSiteAccess(app, b.dataset.grant);
        if (r === 'granted') { toast('Site access granted', 'success'); render(); } else if (r === 'pending') toast('Approve site access in the extension window', 'info', 7000);
        else toast('Connect the browser extension first', 'error');
      } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; }
    });
    page.querySelector('#add-custom').onclick = () => openCustomDialog(app);
    page.querySelectorAll('[data-add-custom]').forEach((b) => b.onclick = () => openCustomDialog(app));
    page.querySelector('#to-catalog').onclick = (e) => { e.preventDefault(); page.querySelector('#catalog').scrollIntoView({ behavior: 'smooth' }); page.querySelector('#cat-search').focus({ preventScroll: true }); };
    const search = page.querySelector('#cat-search');
    search.addEventListener('input', () => {
      filter = search.value.trim();
      const term = filter.toLowerCase();
      page.querySelectorAll('[data-card]').forEach((c) => { c.hidden = !!term && !c.dataset.hay.includes(term); });
      page.querySelectorAll('[data-group]').forEach((g) => { g.hidden = ![...g.querySelectorAll('[data-card]')].some((c) => !c.hidden); });
    });
    if (filter) search.dispatchEvent(new Event('input'));
    refreshIcons();
    if (first && wantsCatalog) page.querySelector('#catalog').scrollIntoView();
    first = false;
  };

  // Site access is granted in an extension window; re-check when the user comes back.
  const onFocus = () => render();
  window.addEventListener('focus', onFocus);
  ctx.cleanup(() => window.removeEventListener('focus', onFocus));
  const off = bridge.on(() => render());
  ctx.cleanup(off);
  ctx.watch(['connections', 'employees'], render, 300);
  await render();
}
