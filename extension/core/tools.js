// Tool executors. There are no third-party API integrations: internal tools work
// on the employee's own local data, knowledge-file tools read locally parsed
// files, and browser tools drive a real tab through the WorkForge extension using
// the owner's own signed-in session. Nothing is simulated — when the extension
// or a system address is missing, the tool fails with a clear explanation.
import { TOOL_MAP, allSystems, systemForUrl, systemUrl } from './catalog.js';
import { retrieve, addMemory, searchFiles, readFile } from './memory.js';
import { uid, now, truncate, sleep } from './util.js';

export class ToolError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Browser tool → extension action.
const BROWSER_ACTIONS = {
  browser_read_page: 'read_page',
  browser_extract: 'extract',
  browser_scroll: 'scroll',
  browser_navigate: 'navigate',
  browser_click: 'click',
  browser_fill: 'fill',
};

function rows(v) { return Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []; }
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
function hostLabel(url) { try { return new URL(url).host; } catch { return String(url || ''); } }
function assertHttpUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new ToolError(`Invalid URL: ${url || '(empty)'}`, 'bad_url'); }
  if (!/^https?:$/.test(u.protocol)) throw new ToolError('Only http(s) URLs can be opened', 'bad_url');
  return u.href;
}

/**
 * @param {object} env
 * @param {import('./db.js').DB} env.db
 * @param {() => Promise<Array<{id:string,url?:string,custom?:boolean,name?:string}>>} env.getConnections rows of the `connections` store
 * @param {{open:(url:string, ctx:object)=>Promise<{tabId:number,url:string,title:string}>,
 *          exec:(action:string, args:object, ctx:object)=>Promise<any>}|null} env.browser
 * @param {{notify?:Function}} [env.hooks]
 */
export function createToolExecutor({ db, getConnections = async () => [], browser = null, hooks = {} } = {}) {
  const connections = async () => rows(await getConnections());

  function needBrowser() {
    if (!browser) throw new ToolError('Browser tools need the WorkForge browser extension. Install and pair it on the Browser Extension page, then run the task again.', 'no_extension');
  }

  // Wrap extension calls so missing site access produces an actionable message.
  async function viaExtension(fn, url, systemName) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code === 'no_host_permission') {
        throw new ToolError(`The WorkForge extension has no site access to ${hostLabel(url)}${systemName ? ` (${systemName})` : ''}. The owner must grant it in Systems — use request_human_help.`, 'no_host_permission');
      }
      throw e instanceof Error ? e : new ToolError(String(e?.message || e));
    }
  }

  // Keep task.browser in sync with what the tab actually shows.
  function track(task, result, fallbackUrl) {
    if (!task?.browser) return;
    const u = (result && typeof result === 'object' && (result.url_after || result.url)) || fallbackUrl;
    const hasTitle = result && typeof result === 'object' && typeof result.title === 'string';
    if (typeof u === 'string' && u && u !== task.browser.url) {
      task.browser.url = u;
      task.browser.origin = originOf(u) || task.browser.origin;
      if (!hasTitle) task.browser.title = ''; // a different page; never keep a stale title
    }
    if (hasTitle) task.browser.title = result.title;
  }

  const executors = {
    // ---------------- internal (always scoped to this employee's own data)
    async memory_search({ query }, { employee }) {
      const r = await retrieve(db, employee, String(query || ''), { k: 8 });
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

    // ---------------- knowledge files (parsed and stored locally)
    async files_search({ query }, { employee }) {
      const r = await searchFiles(db, employee, String(query || ''));
      return r.length ? r : { results: [], note: 'No matching content in granted files.' };
    },
    async files_read({ file_id }, { employee }) {
      return readFile(db, employee, file_id);
    },

    // ---------------- browser (WorkForge extension, owner's signed-in session)
    async browser_open({ system, url }, ctx) {
      const conns = await connections();
      const systems = allSystems(conns);
      const sys = systems[system];
      if (!sys) throw new ToolError(`Unknown system "${system}". Use one of your system ids: ${(ctx.employee?.systems || []).join(', ') || 'none'}.`, 'unknown_system');
      let target;
      if (url) {
        target = assertHttpUrl(url);
        if (systemForUrl(target, conns) !== system) throw new ToolError(`${hostLabel(target)} is not part of ${sys.name}. Open ${sys.name} without a URL, or use a URL inside it.`, 'wrong_system');
      } else {
        target = systemUrl(system, conns);
        if (!target) throw new ToolError(`${sys.name} has no address yet. The owner must connect ${sys.name} and enter its address in Systems — use request_human_help.`, 'no_address');
      }
      needBrowser();
      const task = ctx.task;
      if (task?.browser?.tabId) {
        try {
          const r = await viaExtension(() => browser.exec('navigate', { url: target }, ctx), target, sys.name);
          track(task, r, target);
          return { tabId: task.browser.tabId, url: task.browser.url, title: task.browser.title || '' };
        } catch (e) {
          if (e.code === 'no_host_permission') throw e;
          // The working tab is gone or unusable: open a fresh one below.
        }
      }
      const r = await viaExtension(() => browser.open(target, ctx), target, sys.name);
      if (!r || r.tabId === undefined || r.tabId === null) throw new ToolError('The extension did not return a tab for this task.', 'no_tab');
      const finalUrl = r.url || target;
      if (task) task.browser = { tabId: r.tabId, url: finalUrl, title: r.title || '', origin: originOf(finalUrl) };
      return { tabId: r.tabId, url: finalUrl, title: r.title || '' };
    },

    async browser_wait({ seconds }, ctx) {
      const s = Math.min(10, Math.max(1, Number(seconds) || 2));
      if (ctx.task && !ctx.task.browser?.tabId) throw new ToolError('No working tab — call browser_open first.', 'no_tab');
      await sleep(s * 1000);
      return { waited_seconds: s };
    },
  };

  for (const [name, action] of Object.entries(BROWSER_ACTIONS)) {
    executors[name] = async (args, ctx) => {
      needBrowser();
      const task = ctx.task;
      if (!task?.browser?.tabId) throw new ToolError('No working tab — call browser_open first.', 'no_tab');
      let fallback;
      if (name === 'browser_navigate') fallback = assertHttpUrl(args.url);
      const target = fallback || task.browser.url;
      const r = await viaExtension(() => browser.exec(action, name === 'browser_navigate' ? { ...args, url: fallback } : args, ctx), target);
      track(task, r, fallback);
      return r;
    };
  }

  return {
    has: (name) => !!executors[name],
    async execute(name, args, ctx = {}) {
      const fn = executors[name];
      if (!fn || !TOOL_MAP[name]) throw new ToolError(`Unknown tool ${name}`);
      return fn(args || {}, ctx);
    },
  };
}

// Used by app/fileparse.js to turn uploaded HTML into plain text.
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
