// Tool executors. Every external call is a real HTTP request to the connected
// system using credentials the user supplied; nothing is simulated. When a
// provider blocks browser (CORS) requests, calls go through the WorkForge
// extension relay, or fail with a clear explanation.
import { TOOL_MAP, CONNECTIONS, SYSTEMS } from './catalog.js';
import { retrieve, addMemory, searchFiles, readFile } from './memory.js';
import { b64url, b64urlDecode, uid, now, truncate } from './util.js';

export class ToolError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * @param {object} env
 * @param {import('./db.js').DB} env.db
 * @param {(connId:string)=>Promise<{config:object, secrets:object, status:string}|null>} env.getConnection
 * @param {{fetch:(url:string, init:object, opts:{mode:string})=>Promise<{ok:boolean,status:number,text:()=>Promise<string>}>}} env.transport
 * @param {{exec:(action:string,args:object,ctx:object)=>Promise<any>}|null} env.browser
 * @param {{notify?:Function}} env.hooks
 */
export function createToolExecutor(env) {
  const { db, getConnection, transport, hooks = {} } = env;

  async function conn(id) {
    const c = await getConnection(id);
    if (!c || c.status !== 'connected') {
      throw new ToolError(`${CONNECTIONS[id]?.name || id} is not connected. Connect it in Systems before this tool can run.`, 'not_connected');
    }
    return c;
  }

  async function http(connId, url, init = {}, label) {
    const mode = CONNECTIONS[connId]?.transport || 'direct';
    let res;
    try {
      res = await transport.fetch(url, init, { mode });
    } catch (e) {
      throw new ToolError(e.message || `Network error calling ${label || connId}`, 'network');
    }
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || body?.error_description || body?.errors?.[0]?.message || (typeof body?.error === 'string' ? body.error : '') || truncate(text, 300);
      throw new ToolError(`${label || CONNECTIONS[connId]?.name || connId} returned ${res.status}: ${msg}`, `http_${res.status}`);
    }
    return body;
  }

  async function google() {
    const c = await conn('google');
    if (!c.secrets?.accessToken) throw new ToolError('Google Workspace has no access token. Reconnect it in Systems.', 'not_connected');
    if (c.secrets.expiresAt && c.secrets.expiresAt < Date.now() + 30000) {
      throw new ToolError('The Google access token expired. Click “Reconnect” on Google Workspace in Systems (Google issues 1-hour browser tokens).', 'token_expired');
    }
    return { authorization: `Bearer ${c.secrets.accessToken}` };
  }

  const json = (h = {}) => ({ 'content-type': 'application/json', ...h });

  const executors = {
    // ---------------- internal
    async memory_search({ query }, { employee }) {
      const r = await retrieve(db, employee, query, { k: 8 });
      return r.map((x) => (x.type === 'file' ? { source: `file:${x.fileName}`, file_id: x.fileId, text: truncate(x.text, 700) } : { source: x.kind, text: truncate(x.text, 600) }));
    },
    async memory_save({ content, kind = 'long_term' }, { employee, task }) {
      const m = await addMemory(db, employee.id, kind, content, { source: 'employee', taskId: task?.id });
      return { saved: true, id: m.id };
    },
    async record_metric({ metric, value = 1 }, { task }) {
      const key = String(metric).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      task.metrics = task.metrics || {};
      task.metrics[key] = (task.metrics[key] || 0) + (Number(value) || 1);
      return { metric: key, total_this_task: task.metrics[key] };
    },
    async schedule_followup({ delay_minutes, instruction, entry_script }, { employee, task }) {
      const mins = Math.max(1, Number(delay_minutes) || 60);
      const sched = { id: uid('sch'), employeeId: employee.id, runAt: now() + mins * 60000, instruction: String(instruction), entryScript: entry_script || '', createdBy: task?.id, status: 'scheduled', createdAt: now() };
      await db.put('schedules', sched);
      return { scheduled: true, id: sched.id, run_at: new Date(sched.runAt).toISOString() };
    },
    async notify_user({ title, message }, { employee, task }) {
      if (hooks.notify) await hooks.notify({ employee, task, title, message });
      return { delivered: true };
    },

    // ---------------- files
    async files_search({ query }, { employee }) {
      const r = await searchFiles(db, employee, query);
      return r.length ? r : { results: [], note: 'No matching content in granted files.' };
    },
    async files_read({ file_id }, { employee }) {
      return readFile(db, employee, file_id);
    },

    // ---------------- Gmail
    async gmail_search({ query, max_results = 10 }) {
      const h = await google();
      const list = await http('google', `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(20, max_results)}`, { headers: h }, 'Gmail');
      const msgs = [];
      for (const m of (list.messages || []).slice(0, 15)) {
        const d = await http('google', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: h }, 'Gmail');
        const hd = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        msgs.push({ id: m.id, thread_id: d.threadId, from: hd.from, subject: hd.subject, date: hd.date, snippet: d.snippet });
      }
      return { count: msgs.length, messages: msgs };
    },
    async gmail_read({ message_id }) {
      const h = await google();
      const d = await http('google', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message_id)}?format=full`, { headers: h }, 'Gmail');
      const hd = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      return { id: d.id, thread_id: d.threadId, from: hd.from, to: hd.to, subject: hd.subject, date: hd.date, body: truncate(gmailBody(d.payload), 12000) };
    },
    async gmail_send({ to, subject, body, cc, thread_id }) {
      const h = await google();
      const subj = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject || '')))}?=`;
      const raw = [`To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${subj}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', body || ''].filter((l, i) => l !== '' || i > 3).join('\r\n');
      const r = await http('google', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: json(h), body: JSON.stringify({ raw: b64url(raw), ...(thread_id ? { threadId: thread_id } : {}) }) }, 'Gmail');
      return { sent: true, id: r.id, thread_id: r.threadId };
    },

    // ---------------- Calendar
    async calendar_list_events({ time_min, time_max, query }) {
      const h = await google();
      const p = new URLSearchParams({ timeMin: new Date(time_min).toISOString(), timeMax: new Date(time_max).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
      if (query) p.set('q', query);
      const r = await http('google', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`, { headers: h }, 'Google Calendar');
      return (r.items || []).map((e) => ({ id: e.id, summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, attendees: (e.attendees || []).map((a) => a.email) }));
    },
    async calendar_create_event({ summary, start, end, attendees = [], description }) {
      const h = await google();
      const r = await http('google', 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', {
        method: 'POST', headers: json(h),
        body: JSON.stringify({ summary, description, start: { dateTime: start }, end: { dateTime: end }, attendees: attendees.map((email) => ({ email })) }),
      }, 'Google Calendar');
      return { created: true, id: r.id, link: r.htmlLink };
    },

    // ---------------- Drive / Sheets
    async drive_search({ query }) {
      const h = await google();
      const q = `(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}') and trashed = false`;
      const r = await http('google', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, { headers: h }, 'Google Drive');
      return r.files || [];
    },
    async drive_read({ file_id }) {
      const h = await google();
      const meta = await http('google', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType`, { headers: h }, 'Google Drive');
      const exportMime = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[meta.mimeType];
      const url = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file_id)}/export?mimeType=${encodeURIComponent(exportMime)}`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file_id)}?alt=media`;
      if (!exportMime && !/^text\/|json|csv|xml/.test(meta.mimeType)) return { name: meta.name, mimeType: meta.mimeType, note: 'Binary file; only text-based files can be read.' };
      const text = await http('google', url, { headers: h }, 'Google Drive');
      return { name: meta.name, mimeType: meta.mimeType, text: truncate(typeof text === 'string' ? text : JSON.stringify(text), 15000) };
    },
    async sheets_read({ spreadsheet_id, range }) {
      const h = await google();
      const r = await http('google', `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}`, { headers: h }, 'Google Sheets');
      return { range: r.range, values: (r.values || []).slice(0, 200) };
    },
    async sheets_append({ spreadsheet_id, range, rows }) {
      const h = await google();
      const r = await http('google', `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, { method: 'POST', headers: json(h), body: JSON.stringify({ values: rows }) }, 'Google Sheets');
      return { updated_range: r.updates?.updatedRange, rows: r.updates?.updatedRows };
    },

    // ---------------- Slack
    async slack_post_message({ channel, text }) {
      const c = await conn('slack');
      const r = await http('slack', 'https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.secrets.token, channel, text }).toString() }, 'Slack');
      if (!r.ok) throw new ToolError(`Slack error: ${r.error}`);
      return { posted: true, channel: r.channel, ts: r.ts };
    },
    async slack_read_channel({ channel, limit = 20 }) {
      const c = await conn('slack');
      const r = await http('slack', 'https://slack.com/api/conversations.history', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.secrets.token, channel, limit: String(Math.min(50, limit)) }).toString() }, 'Slack');
      if (!r.ok) throw new ToolError(`Slack error: ${r.error}`);
      return (r.messages || []).map((m) => ({ user: m.user, text: m.text, ts: m.ts }));
    },

    // ---------------- HubSpot
    async hubspot_search({ object_type, query }) {
      const c = await conn('hubspot');
      const r = await http('hubspot', `https://api.hubapi.com/crm/v3/objects/${object_type}/search`, { method: 'POST', headers: json({ authorization: `Bearer ${c.secrets.token}` }), body: JSON.stringify({ query, limit: 10 }) });
      return { total: r.total, results: (r.results || []).map((x) => ({ id: x.id, properties: x.properties })) };
    },
    async hubspot_create({ object_type, properties }) {
      const c = await conn('hubspot');
      const r = await http('hubspot', `https://api.hubapi.com/crm/v3/objects/${object_type}`, { method: 'POST', headers: json({ authorization: `Bearer ${c.secrets.token}` }), body: JSON.stringify({ properties }) });
      return { created: true, id: r.id };
    },
    async hubspot_update({ object_type, id, properties }) {
      const c = await conn('hubspot');
      const r = await http('hubspot', `https://api.hubapi.com/crm/v3/objects/${object_type}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: json({ authorization: `Bearer ${c.secrets.token}` }), body: JSON.stringify({ properties }) });
      return { updated: true, id: r.id };
    },

    // ---------------- Salesforce
    async salesforce_query({ soql }) {
      const c = await conn('salesforce');
      const r = await http('salesforce', `${sfBase(c)}/query?q=${encodeURIComponent(soql)}`, { headers: { authorization: `Bearer ${c.secrets.accessToken}` } });
      return { total: r.totalSize, records: (r.records || []).slice(0, 50) };
    },
    async salesforce_create({ sobject, fields }) {
      const c = await conn('salesforce');
      const r = await http('salesforce', `${sfBase(c)}/sobjects/${sobject}`, { method: 'POST', headers: json({ authorization: `Bearer ${c.secrets.accessToken}` }), body: JSON.stringify(fields) });
      return { created: r.success !== false, id: r.id };
    },
    async salesforce_update({ sobject, id, fields }) {
      const c = await conn('salesforce');
      await http('salesforce', `${sfBase(c)}/sobjects/${sobject}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: json({ authorization: `Bearer ${c.secrets.accessToken}` }), body: JSON.stringify(fields) });
      return { updated: true, id };
    },

    // ---------------- Shopify
    async shopify_list({ resource, params = {} }) {
      const c = await conn('shopify');
      const qs = new URLSearchParams({ limit: '20', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
      const r = await http('shopify', `https://${shopHost(c)}/admin/api/2024-10/${resource}.json?${qs}`, { headers: { 'x-shopify-access-token': c.secrets.token } });
      return r[resource] || r;
    },
    async shopify_update({ resource, id, data }) {
      const c = await conn('shopify');
      const singular = resource.replace(/s$/, '');
      const r = await http('shopify', `https://${shopHost(c)}/admin/api/2024-10/${resource}/${encodeURIComponent(id)}.json`, { method: 'PUT', headers: json({ 'x-shopify-access-token': c.secrets.token }), body: JSON.stringify({ [singular]: { id: Number(id) || id, ...data } }) });
      return { updated: true, record: r[singular] ? { id: r[singular].id } : r };
    },

    // ---------------- Notion
    async notion_search({ query }) {
      const c = await conn('notion');
      const r = await http('notion', 'https://api.notion.com/v1/search', { method: 'POST', headers: json({ authorization: `Bearer ${c.secrets.token}`, 'notion-version': '2022-06-28' }), body: JSON.stringify({ query, page_size: 10 }) });
      return (r.results || []).map((p) => ({ id: p.id, object: p.object, url: p.url, title: notionTitle(p) }));
    },
    async notion_create_page({ parent_page_id, title, content }) {
      const c = await conn('notion');
      const children = String(content || '').split(/\n\s*\n/).filter(Boolean).slice(0, 90).map((para) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: para.slice(0, 1900) } }] } }));
      const r = await http('notion', 'https://api.notion.com/v1/pages', { method: 'POST', headers: json({ authorization: `Bearer ${c.secrets.token}`, 'notion-version': '2022-06-28' }), body: JSON.stringify({ parent: { page_id: parent_page_id }, properties: { title: { title: [{ text: { content: title } }] } }, children }) });
      return { created: true, id: r.id, url: r.url };
    },

    // ---------------- Zendesk
    async zendesk_search({ query }) {
      const c = await conn('zendesk');
      const r = await http('zendesk', `https://${c.config.subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(query)}`, { headers: zdAuth(c) });
      return { count: r.count, results: (r.results || []).slice(0, 20).map((t) => ({ id: t.id, type: t.result_type, subject: t.subject, status: t.status, priority: t.priority, description: truncate(t.description || '', 500) })) };
    },
    async zendesk_create_ticket({ subject, body, requester_email, priority }) {
      const c = await conn('zendesk');
      const ticket = { subject, comment: { body }, ...(priority ? { priority } : {}), ...(requester_email ? { requester: { email: requester_email } } : {}) };
      const r = await http('zendesk', `https://${c.config.subdomain}.zendesk.com/api/v2/tickets.json`, { method: 'POST', headers: json(zdAuth(c)), body: JSON.stringify({ ticket }) });
      return { created: true, id: r.ticket?.id };
    },
    async zendesk_update_ticket({ id, comment, public: isPublic = false, status }) {
      const c = await conn('zendesk');
      const ticket = { ...(comment ? { comment: { body: comment, public: !!isPublic } } : {}), ...(status ? { status } : {}) };
      const r = await http('zendesk', `https://${c.config.subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(id)}.json`, { method: 'PUT', headers: json(zdAuth(c)), body: JSON.stringify({ ticket }) });
      return { updated: true, id: r.ticket?.id, status: r.ticket?.status };
    },

    // ---------------- Database / API / Webhook
    async db_select({ table, query = 'select=*&limit=20' }) {
      const c = await conn('database');
      return http('database', `${c.config.endpoint.replace(/\/$/, '')}/${encodeURIComponent(table)}?${query}`, { headers: authHeader(c) });
    },
    async db_insert({ table, rows }) {
      const c = await conn('database');
      return http('database', `${c.config.endpoint.replace(/\/$/, '')}/${encodeURIComponent(table)}`, { method: 'POST', headers: json({ ...authHeader(c), prefer: 'return=representation' }), body: JSON.stringify(rows) });
    },
    async api_request({ method = 'GET', path, body }) {
      const c = await conn('api');
      const url = new URL(path, c.config.baseUrl.replace(/\/?$/, '/'));
      if (!url.href.startsWith(new URL(c.config.baseUrl).origin)) throw new ToolError('Path must stay on the configured API origin');
      return http('api', url.href, { method, headers: json(authHeader(c)), ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) }, 'Custom API');
    },
    async webhook_send({ payload }) {
      const c = await conn('webhook');
      const r = await http('webhook', c.secrets.url, { method: 'POST', headers: json(), body: JSON.stringify(payload) }, 'Webhook');
      return { sent: true, response: truncate(r, 500) };
    },

    // ---------------- Web research
    async web_fetch({ url }) {
      if (!/^https?:\/\//i.test(url)) throw new ToolError('Only http(s) URLs can be fetched');
      let res;
      try {
        res = await transport.fetch(url, { method: 'GET' }, { mode: 'direct-or-relay', web: true });
      } catch (e) {
        throw new ToolError(`${e.message}`, 'network');
      }
      const text = await res.text();
      if (!res.ok) throw new ToolError(`${new URL(url).host} returned ${res.status}`);
      return { url, status: res.status, text: truncate(htmlToText(text), 12000) };
    },
  };

  // Browser tools are executed by the extension in the working tab.
  for (const name of ['browser_read_page', 'browser_extract', 'browser_navigate', 'browser_click', 'browser_fill', 'browser_scroll']) {
    executors[name] = async (args, ctx) => {
      if (!env.browser) throw new ToolError('Browser tools need the WorkForge extension. Install it from the Browser Extension page and connect it.', 'no_extension');
      if (!ctx.task?.browser?.tabId) throw new ToolError('No browser tab is assigned to this task. Start the employee from the extension, or choose a tab when running the task.', 'no_tab');
      if (name === 'browser_navigate') assertAllowedDomain(ctx.employee, ctx.task, args.url);
      return env.browser.exec(name.replace('browser_', ''), args, ctx);
    };
  }

  return {
    has: (name) => !!executors[name],
    async execute(name, args, ctx) {
      const fn = executors[name];
      if (!fn || !TOOL_MAP[name]) throw new ToolError(`Unknown tool ${name}`);
      return fn(args || {}, ctx);
    },
  };
}

export function assertAllowedDomain(employee, task, url) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new ToolError('Invalid URL'); }
  if (!/^https?:/.test(new URL(url).protocol)) throw new ToolError('Only http(s) navigation is allowed');
  const allowed = [...(employee.browser?.domains || [])];
  if (task?.browser?.origin) allowed.push(new URL(task.browser.origin).hostname);
  const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) throw new ToolError(`Navigation to ${host} is outside ${employee.name}'s allowed domains (${allowed.join(', ') || 'none'}). Add it under Permissions → Browser.`, 'domain_blocked');
}

function sfBase(c) { return `${c.config.instanceUrl.replace(/\/$/, '')}/services/data/v61.0`; }
function shopHost(c) { return c.config.shop.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
function zdAuth(c) { return { authorization: `Basic ${btoa(`${c.config.email}/token:${c.secrets.apiToken}`)}` }; }
function authHeader(c) { return c.config.headerName && c.secrets.headerValue ? { [c.config.headerName]: c.secrets.headerValue } : {}; }
function notionTitle(p) {
  const props = p.properties || {};
  for (const v of Object.values(props)) if (v?.type === 'title') return (v.title || []).map((t) => t.plain_text).join('');
  return (p.title || []).map((t) => t.plain_text).join('') || '(untitled)';
}

function gmailBody(payload) {
  if (!payload) return '';
  const parts = [];
  const walk = (p) => {
    if (p.mimeType === 'text/plain' && p.body?.data) parts.push(b64urlDecode(p.body.data));
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  if (parts.length) return parts.join('\n');
  const html = [];
  const walkHtml = (p) => { if (p.mimeType === 'text/html' && p.body?.data) html.push(b64urlDecode(p.body.data)); (p.parts || []).forEach(walkHtml); };
  walkHtml(payload);
  if (html.length) return htmlToText(html.join('\n'));
  return payload.body?.data ? b64urlDecode(payload.body.data) : '';
}

export function htmlToText(html) {
  const s = String(html || '');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(s, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,iframe').forEach((n) => n.remove());
    const title = doc.title ? `${doc.title}\n\n` : '';
    return (title + (doc.body?.innerText || doc.body?.textContent || '')).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  return s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function systemLabel(sys) { return SYSTEMS[sys]?.name || sys; }
