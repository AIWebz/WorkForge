// Browser tool implementations executed in the employee's working tab via
// chrome.scripting. Used by both the side panel runtime and the background
// worker (for tasks started from the web app).

export async function hasHostAccess(url) {
  const origin = new URL(url).origin;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
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
  try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('The working tab was closed.'); }
  if (!/^https?:/.test(tab.url || '')) throw new Error('Employees can only work on http(s) pages.');
  if (!(await hasHostAccess(tab.url))) throw new Error(`WorkForce has no access to ${new URL(tab.url).host}. Grant it from the WorkForce side panel (Start Working asks for it).`);

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
      if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs');
      if (!(await hasHostAccess(url))) throw new Error(`WorkForce has no access to ${new URL(url).host}. Add the site in the side panel before navigating there.`);
      await chrome.tabs.update(tabId, { url });
      await new Promise((res) => setTimeout(res, 400));
      await waitForComplete(tabId);
      const t = await chrome.tabs.get(tabId);
      return { url: t.url, title: t.title };
    }
    default: throw new Error(`Unknown browser action ${action}`);
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
      if (items.length >= 160 || !visible(el)) return;
      let ref = el.getAttribute('data-wf-ref');
      if (!ref) {
        window.__wfRefSeq = (window.__wfRefSeq || 0) + 1;
        ref = `e${window.__wfRefSeq}`;
        el.setAttribute('data-wf-ref', ref);
      }
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase();
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : '';
      const label = (el.getAttribute('aria-label') || forLabel || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
      const item = { ref, tag, label };
      if (type) item.type = type;
      if (tag === 'a') item.href = String(el.href).slice(0, 200);
      if (['input', 'textarea', 'select'].includes(tag) && type !== 'password') item.value = String(el.value || '').slice(0, 120);
      if (type === 'password') item.note = 'password field (not accessible)';
      if (tag === 'select') item.options = [...el.options].slice(0, 25).map((o) => o.text.trim());
      items.push(item);
    });
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 14000);
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
