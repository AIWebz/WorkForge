// Browser tool implementations executed in the employee's working tab via
// chrome.scripting. Used by both the side panel runtime and the background
// worker (for tasks started from the web app). Everything runs in the user's own
// signed-in browser session; nothing here calls a third-party API.

export class BrowserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export async function hasHostAccess(url) {
  const origin = new URL(url).origin;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

function noAccess(host, hint) {
  return new BrowserError(`WorkForge has no access to ${host}. ${hint}`, 'no_host_permission');
}

/**
 * Open a URL in a new working tab and wait for it to load.
 * Requires host permission for the URL's origin (checked first; nothing is opened without it).
 * @returns {Promise<{tabId:number, url:string, title:string}>}
 */
export async function openWorkingTab(url, { active = false } = {}) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new BrowserError(`Invalid address: ${url || '(empty)'}`, 'invalid_url'); }
  if (!/^https?:$/.test(u.protocol)) throw new BrowserError('Employees can only open http(s) pages.', 'invalid_url');
  if (!(await hasHostAccess(u.href))) throw noAccess(u.host, 'Allow this site in the WorkForge side panel (Start Working asks for it) or from the app\'s Systems page.');
  const created = await chrome.tabs.create({ url: u.href, active: !!active });
  await new Promise((res) => setTimeout(res, 300));
  await waitForComplete(created.id, 20000);
  let tab;
  try { tab = await chrome.tabs.get(created.id); } catch { throw new BrowserError('The working tab was closed while loading.', 'tab_closed'); }
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || u.href, title: tab.title || u.host };
}

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  const out = res?.result;
  if (out && out.__error) throw new Error(out.__error);
  return out;
}

function waitForComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') setTimeout(done, 300); }).catch(done);
  });
}

export async function runBrowserAction(tabId, action, args = {}) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw new BrowserError('The working tab was closed.', 'tab_closed'); }
  if (!/^https?:/.test(tab.url || '')) throw new BrowserError('Employees can only work on http(s) pages.', 'invalid_url');
  if (!(await hasHostAccess(tab.url))) {
    throw noAccess(new URL(tab.url).host, 'If this is a sign-in page, sign in to the app in that tab yourself, then run the task again. Otherwise allow the site from the WorkForge side panel.');
  }

  switch (action) {
    case 'read_page': return exec(tabId, readPage);
    case 'extract': return exec(tabId, extract, [String(args.selector || 'body'), Math.min(50, Number(args.limit) || 20)]);
    case 'scroll': return exec(tabId, scroll, [args.direction === 'up' ? 'up' : 'down']);
    case 'click': {
      const r = await exec(tabId, click, [String(args.ref || '')]);
      await new Promise((res) => setTimeout(res, 700));
      await waitForComplete(tabId, 8000);
      const after = await chrome.tabs.get(tabId);
      return { ...r, url_after: after.url };
    }
    case 'fill': return exec(tabId, fill, [String(args.ref || ''), String(args.value ?? '')]);
    case 'navigate': {
      const url = String(args.url || '');
      if (!/^https?:\/\//.test(url)) throw new BrowserError('Only http(s) URLs can be opened.', 'invalid_url');
      if (!(await hasHostAccess(url))) throw noAccess(new URL(url).host, 'Allow the site in the WorkForge side panel before navigating there.');
      await chrome.tabs.update(tabId, { url });
      await new Promise((res) => setTimeout(res, 400));
      await waitForComplete(tabId);
      const t = await chrome.tabs.get(tabId);
      return { url: t.url, title: t.title };
    }
    default: throw new BrowserError(`Unknown browser action ${action}`, 'unknown_action');
  }
}

// ----- Functions below are serialized into the page; they must be self-contained.
function readPage() {
  try {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    const items = [];
    document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true]').forEach((el) => {
      if (items.length >= 70 || !visible(el)) return;
      let ref = el.getAttribute('data-wf-ref');
      if (!ref) {
        window.__wfRefSeq = (window.__wfRefSeq || 0) + 1;
        ref = `e${window.__wfRefSeq}`;
        el.setAttribute('data-wf-ref', ref);
      }
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase();
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : '';
      const label = (el.getAttribute('aria-label') || forLabel || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 70);
      const item = { ref, tag, label };
      if (type) item.type = type;
      if (tag === 'a') item.href = String(el.href).slice(0, 200);
      if (['input', 'textarea', 'select'].includes(tag) && type !== 'password') item.value = String(el.value || '').slice(0, 120);
      if (type === 'password') item.note = 'password field (not accessible)';
      if (tag === 'select') item.options = [...el.options].slice(0, 25).map((o) => o.text.trim());
      items.push(item);
    });
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
    return { url: location.href, title: document.title, text, elements: items, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
  } catch (e) { return { __error: e.message }; }
}

function extract(selector, limit) {
  try {
    const nodes = [...document.querySelectorAll(selector)].slice(0, limit);
    return { selector, count: nodes.length, items: nodes.map((n) => ({ text: (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 600), href: n.href || undefined })) };
  } catch (e) { return { __error: `Invalid selector or extraction failed: ${e.message}` }; }
}

function scroll(direction) {
  window.scrollBy({ top: (direction === 'up' ? -1 : 1) * innerHeight * 0.85, behavior: 'instant' });
  return { y: Math.round(scrollY), height: document.documentElement.scrollHeight };
}

function click(ref) {
  const el = document.querySelector(`[data-wf-ref="${CSS.escape(ref)}"]`);
  if (!el) return { __error: `Element ${ref} not found — call browser_read_page again to refresh element refs.` };
  el.scrollIntoView({ block: 'center' });
  const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80);
  el.click();
  return { clicked: true, ref, label };
}

function fill(ref, value) {
  const el = document.querySelector(`[data-wf-ref="${CSS.escape(ref)}"]`);
  if (!el) return { __error: `Element ${ref} not found — call browser_read_page again.` };
  if ((el.getAttribute('type') || '').toLowerCase() === 'password') return { __error: 'Employees are not allowed to type into password fields.' };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const opt = [...el.options].find((o) => o.value === value || o.text.trim().toLowerCase() === value.toLowerCase());
    if (!opt) return { __error: `No option “${value}”. Options: ${[...el.options].map((o) => o.text.trim()).slice(0, 20).join(', ')}` };
    el.value = opt.value;
  } else if (el.isContentEditable) {
    el.textContent = value;
  } else {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: true, ref };
}
