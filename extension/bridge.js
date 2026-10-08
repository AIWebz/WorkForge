// Content script: relays messages between a WorkForge app page and the
// extension's background worker. It only activates on pages that declare
// <meta name="workforge-app">, and the background only serves origins the user
// explicitly paired.
(() => {
  if (window.__workforgeBridge) return;
  window.__workforgeBridge = true;
  const isApp = () => !!document.querySelector('meta[name="workforge-app"]');

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
