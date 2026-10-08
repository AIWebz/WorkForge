// Content script: relays messages between a WorkForce app page and the
// extension's background worker. It only activates on pages that declare
// <meta name="workforce-app">, and the background only serves origins the user
// explicitly paired.
(() => {
  if (window.__workforceBridge) return;
  window.__workforceBridge = true;
  const isApp = () => !!document.querySelector('meta[name="workforce-app"]');

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__wf !== 'request' || !isApp()) return;
    const { id, type, payload } = e.data;
    try {
      chrome.runtime.sendMessage({ channel: 'wf-bridge', type, payload }, (resp) => {
        const err = chrome.runtime.lastError;
        window.postMessage({ __wf: 'response', id, ok: !err && !!resp?.ok, data: resp?.data, error: err ? err.message : resp?.error, code: resp?.code }, window.location.origin);
      });
    } catch (err) {
      window.postMessage({ __wf: 'response', id, ok: false, error: `Extension unavailable: ${err.message}. Reload the page.` }, window.location.origin);
    }
  });

  const announce = () => { if (isApp()) window.postMessage({ __wf: 'ext-ready' }, window.location.origin); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
})();
