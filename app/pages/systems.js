import { esc, icon, sysIcon, statusBadge, timeAgo, refreshIcons, toast, modal, confirmDialog, emptyState, loadScript } from '../ui.js';
import { CONNECTIONS, SYSTEMS } from '../../extension/core/catalog.js';
import { now } from '../../extension/core/util.js';
import { transport } from '../state.js';
import { bridge } from '../bridge.js';
import { requestGoogleToken } from '../google.js';

// Real connectivity checks against each provider's API.
const TESTS = {
  async slack(c, s) {
    const r = await call('slack', 'https://slack.com/api/auth.test', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: s.token }).toString() });
    if (!r.ok) throw new Error(`Slack: ${r.error}`);
    return `${r.team} · ${r.user}`;
  },
  async hubspot(c, s) {
    await call('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { authorization: `Bearer ${s.token}` } });
    return 'HubSpot CRM';
  },
  async salesforce(c, s) {
    await call('salesforce', `${c.instanceUrl.replace(/\/$/, '')}/services/data/v61.0/`, { headers: { authorization: `Bearer ${s.accessToken}` } });
    return new URL(c.instanceUrl).host;
  },
  async shopify(c, s) {
    const host = c.shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const r = await call('shopify', `https://${host}/admin/api/2024-10/shop.json`, { headers: { 'x-shopify-access-token': s.token } });
    return r.shop?.name || host;
  },
  async notion(c, s) {
    const r = await call('notion', 'https://api.notion.com/v1/users/me', { headers: { authorization: `Bearer ${s.token}`, 'notion-version': '2022-06-28' } });
    return r.name || 'Notion integration';
  },
  async zendesk(c, s) {
    const r = await call('zendesk', `https://${c.subdomain}.zendesk.com/api/v2/users/me.json`, { headers: { authorization: `Basic ${btoa(`${c.email}/token:${s.apiToken}`)}` } });
    if (!r.user?.id) throw new Error('Zendesk did not authenticate this agent');
    return r.user.email;
  },
  async database(c, s) {
    await call('database', `${c.endpoint.replace(/\/$/, '')}/`, { headers: c.headerName ? { [c.headerName]: s.headerValue } : {} });
    return new URL(c.endpoint).host;
  },
  async api(c, s) {
    const res = await transport.fetch(c.baseUrl, { headers: c.headerName ? { [c.headerName]: s.headerValue } : {} }, { mode: 'direct-or-relay' });
    if (res.status === 401 || res.status === 403) throw new Error(`Authentication failed (${res.status})`);
    if (res.status >= 500) throw new Error(`Server error ${res.status}`);
    return new URL(c.baseUrl).host;
  },
  async webhook() { return 'Webhook URL saved (not called during setup)'; },
};

async function call(connId, url, init) {
  const res = await transport.fetch(url, init, { mode: CONNECTIONS[connId].transport });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  if (!res.ok) throw new Error(`${CONNECTIONS[connId].name} returned ${res.status}: ${body?.message || body?.error?.message || (typeof body === 'string' ? body.slice(0, 160) : '')}`);
  return body;
}

export async function testConnectionRecord(app, id) {
  const rec = await app.db.get('connections', id);
  const secrets = app.vault.get(`conn.${id}`) || {};
  try {
    let account;
    if (id === 'google') {
      if (!secrets.accessToken || secrets.expiresAt < Date.now()) throw new Error('Token expired — reconnect with Google');
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${secrets.accessToken}` } });
      if (!r.ok) throw new Error(`Google returned ${r.status}`);
      account = (await r.json()).email;
    } else account = await TESTS[id](rec.config, secrets);
    await app.db.put('connections', { ...rec, status: 'connected', account, lastTest: { ok: true, at: now(), message: 'OK' } });
    return { ok: true, account };
  } catch (e) {
    await app.db.put('connections', { ...rec, status: 'error', lastTest: { ok: false, at: now(), message: e.message } });
    return { ok: false, error: e.message };
  }
}

export function openConnectDialog(app, id) {
  const def = CONNECTIONS[id];
  if (app.vault.locked) return toast('Unlock the credential vault first (Settings → Security)', 'error');
  if (id === 'google') loadScript('https://accounts.google.com/gsi/client').catch(() => {});
  app.db.get('connections', id).then((existing) => {
    const cfg = existing?.config || {};
    const secrets = app.vault.get(`conn.${id}`) || {};
    const relayNote = def.transport === 'relay'
      ? `<div class="callout ${bridge.paired ? 'success' : 'warn'}">${icon('puzzle')}<div class="small">${esc(def.name)} blocks requests from web pages, so WorkForge relays calls through the browser extension. ${bridge.paired ? 'Extension connected ✓' : '<a href="#/extension">Install and connect the extension</a> before testing.'}</div></div>`
      : def.transport === 'direct-or-relay' ? `<p class="help">Calls go directly from your browser when the service allows it (CORS); otherwise through the extension relay${bridge.paired ? ' (connected)' : ''}.</p>` : '';
    modal({
      title: `Connect ${def.name}`,
      subtitle: `Gives employees access to: ${def.systems.map((s) => SYSTEMS[s].name).join(', ')}. Tokens are stored in your browser's credential vault (${app.vault.mode}), never in source code.`,
      body: `<div class="form-grid">
        ${def.fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${f.multiline ? `<textarea class="textarea" rows="3" data-f="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(cfg[f.key] || '')}</textarea>` : `<input class="input" data-f="${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : ''} placeholder="${esc(f.secret && secrets[f.key] ? '•••••••• saved — leave blank to keep' : f.placeholder || '')}" value="${f.secret ? '' : esc(cfg[f.key] || '')}">`}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`).join('')}
        ${id === 'google' ? `<div class="callout">${icon('info')}<div class="small">Authorized JavaScript origin to add in Google Cloud Console: <code>${esc(location.origin)}</code>. Enable the Gmail, Calendar, Drive and Sheets APIs. Google browser tokens last about one hour; reconnect when they expire.</div></div>` : ''}
        ${relayNote}
      </div>`,
      actions: [
        ...(existing ? [{ label: 'Disconnect', danger: true, onClick: async () => { await disconnect(app, id); } }] : []),
        { label: 'Cancel' },
        { label: id === 'google' ? 'Sign in with Google' : 'Save & test', primary: true, icon: 'plug-zap', onClick: async (m) => {
          const config = { ...cfg };
          const sec = { ...secrets };
          for (const f of def.fields) {
            const v = m.querySelector(`[data-f="${f.key}"]`).value.trim();
            if (f.secret) { if (v) sec[f.key] = v; } else config[f.key] = v;
          }
          const missing = def.fields.filter((f) => !f.multiline && !(f.secret ? sec[f.key] : config[f.key]) && !/header/i.test(f.key));
          if (missing.length) throw new Error(`Missing: ${missing.map((f) => f.label).join(', ')}`);
          if (id === 'google') {
            const tok = await requestGoogleToken(config.clientId);
            Object.assign(sec, tok);
            await app.vault.set(`conn.${id}`, sec);
            await app.db.put('connections', { id, status: 'connected', config, account: tok.email, connectedAt: now(), lastTest: { ok: true, at: now(), message: 'OAuth token granted' } });
            toast(`Google Workspace connected${tok.email ? ` (${tok.email})` : ''}`, 'success');
            return;
          }
          await app.vault.set(`conn.${id}`, sec);
          await app.db.put('connections', { id, status: 'pending', config, connectedAt: existing?.connectedAt || now() });
          const r = await testConnectionRecord(app, id);
          if (r.ok) toast(`${def.name} connected · ${r.account}`, 'success');
          else { toast(`${def.name}: ${r.error}`, 'error'); return false; }
        } },
      ],
    });
  });
}

async function disconnect(app, id) {
  await app.vault.remove(`conn.${id}`);
  await app.db.delete('connections', id);
  toast(`${CONNECTIONS[id].name} disconnected`);
}

export default async function systemsPage(ctx) {
  const { el, app } = ctx;
  const isCatalog = location.hash.startsWith('#/integrations');
  el.innerHTML = '<div class="page" id="sp"></div>';
  const page = el.querySelector('#sp');
  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [conns, employees] = await Promise.all([app.connectionMap(), app.db.all('employees')]);
    const usedBy = (connId) => employees.filter((e) => CONNECTIONS[connId].systems.some((s) => e.permissions?.[s]));
    if (isCatalog) {
      const groups = {};
      for (const [id, c] of Object.entries(CONNECTIONS)) {
        const g = SYSTEMS[c.systems[0]].group;
        (groups[g] = groups[g] || []).push([id, c]);
      }
      page.innerHTML = `<div class="page-head"><div><h1>Integrations</h1><p>Connect the systems your employees work in. Each connection uses your own credentials and real APIs.</p></div><a class="btn" href="#/systems">${icon('server')} Connected systems</a></div>
        ${Object.entries(groups).map(([g, list]) => `<h3 class="mb-8 mt-16">${esc(g)}</h3><div class="grid-3">${list.map(([id, c]) => `<div class="int-card"><div class="between"><div class="row">${sysIcon(id)}<div class="strong">${esc(c.name)}</div></div>${conns[id] ? statusBadge(conns[id].status === 'connected' ? 'connected' : 'error', conns[id].status === 'connected' ? 'Connected' : 'Needs attention') : ''}</div>
          <p class="small muted">${esc(c.systems.map((s) => SYSTEMS[s].description).join(' '))}</p>
          <div class="between"><span class="tiny muted">${c.transport === 'relay' ? `${icon('puzzle')} via extension relay` : c.transport === 'direct' ? 'Direct from browser' : 'Direct or via extension'}</span><button class="btn btn-sm ${conns[id] ? '' : 'btn-primary'}" data-connect="${id}">${conns[id] ? 'Manage' : 'Connect'}</button></div></div>`).join('')}</div>`).join('')}
        <h3 class="mb-8 mt-24">Built in</h3><div class="grid-3">${['files', 'browser', 'web'].map((s) => `<div class="int-card"><div class="row">${sysIcon(s)}<div class="strong">${esc(SYSTEMS[s].name)}</div></div><p class="small muted">${esc(SYSTEMS[s].description)}</p><a class="btn btn-sm" href="${s === 'files' ? '#/files' : '#/extension'}">${s === 'files' ? 'Manage files' : 'Set up extension'}</a></div>`).join('')}</div>`;
    } else {
      const rows = Object.values(conns);
      page.innerHTML = `<div class="page-head"><div><h1>Systems</h1><p>Live status of every connected system, which employees use it, and the last connectivity test.</p></div><a class="btn btn-primary" href="#/integrations">${icon('plus')} Add integration</a></div>
        <div class="stats mb-16">
          <div class="stat"><div class="stat-top">Connected</div><div class="stat-value">${rows.filter((r) => r.status === 'connected').length}</div></div>
          <div class="stat"><div class="stat-top">Needs attention</div><div class="stat-value">${rows.filter((r) => r.status !== 'connected').length}</div></div>
          <div class="stat"><div class="stat-top">Extension relay</div><div class="stat-value" style="font-size:16px">${bridge.paired ? 'Connected' : bridge.available ? 'Not paired' : 'Not installed'}</div></div>
          <div class="stat"><div class="stat-top">AI engine</div><div class="stat-value" style="font-size:16px">${(await app.aiReady()) ? 'Ready' : 'Not configured'}</div></div>
        </div>
        ${rows.length ? `<div class="card"><div class="table-wrap"><table class="log-table"><thead><tr><th>System</th><th>Account</th><th>Used by</th><th>Last test</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td><div class="row">${sysIcon(r.id)}<div><div class="strong small">${esc(CONNECTIONS[r.id]?.name || r.id)}</div><div class="tiny muted">${esc(CONNECTIONS[r.id]?.systems.map((s) => SYSTEMS[s].name).join(', ') || '')}</div></div></div></td>
            <td class="small">${esc(r.account || '—')}${r.id === 'google' && app.vault.get('conn.google')?.expiresAt ? `<div class="tiny muted">token ${app.vault.get('conn.google').expiresAt > Date.now() ? `expires ${timeAgo(app.vault.get('conn.google').expiresAt)}` : 'expired'}</div>` : ''}</td>
            <td class="small">${usedBy(r.id).map((e) => esc(e.name)).join(', ') || '—'}</td>
            <td class="small ${r.lastTest?.ok ? 'muted' : 's-err'}">${r.lastTest ? `${timeAgo(r.lastTest.at)}${r.lastTest.ok ? '' : ` — ${esc(r.lastTest.message)}`}` : '—'}</td>
            <td>${statusBadge(r.status === 'connected' ? 'connected' : 'error', r.status === 'connected' ? 'Connected' : 'Error')}</td>
            <td><div class="row gap-6"><button class="btn btn-xs" data-test="${r.id}">${icon('activity')} Test</button><button class="btn btn-xs" data-connect="${r.id}">${r.id === 'google' ? 'Reconnect' : 'Edit'}</button><button class="btn btn-xs btn-ghost" data-disc="${r.id}">${icon('unplug')}</button></div></td></tr>`).join('')}
        </tbody></table></div></div>` : `<div class="card">${emptyState('server', 'No systems connected', 'Connect Gmail, Slack, your CRM and more so employees can do real work.', '<a class="btn btn-primary" href="#/integrations">Browse integrations</a>')}</div>`}`;
    }
    page.querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => openConnectDialog(app, b.dataset.connect));
    page.querySelectorAll('[data-test]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      const r = await testConnectionRecord(app, b.dataset.test);
      toast(r.ok ? `Connection OK · ${r.account}` : r.error, r.ok ? 'success' : 'error');
    });
    page.querySelectorAll('[data-disc]').forEach((b) => b.onclick = async () => {
      if (await confirmDialog(`Disconnect ${CONNECTIONS[b.dataset.disc].name}? Credentials are removed from the vault and employees lose access.`, { danger: true, confirm: 'Disconnect' })) await disconnect(app, b.dataset.disc);
    });
    refreshIcons();
  };
  ctx.watch(['connections', 'employees'], render, 300);
  await render();
}
