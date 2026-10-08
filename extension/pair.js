// Approval window for pairing a WorkForce app origin and for granting site access.
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const el = document.getElementById('content');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (mode === 'pair') {
  const origin = params.get('origin') || '';
  el.innerHTML = `<h2>Connect this WorkForce workspace?</h2>
    <p class="origin">${esc(origin)}</p>
    <p>Only allow this if it is <strong>your</strong> WorkForce app. Once connected, it can:</p>
    <ul>
      <li>Sync your employees, knowledge and settings into the extension</li>
      <li>Share AI and system credentials with the extension (if enabled in its Security settings)</li>
      <li>See the titles and addresses of your open tabs when you choose a tab for a task</li>
      <li>Relay API requests to services you connected (HubSpot, Notion, Shopify, Zendesk…)</li>
      <li>Run browser actions in tabs you granted, within each employee's permissions</li>
    </ul>
    <div class="actions"><button class="btn" id="deny">Deny</button><button class="btn primary" id="allow">Allow</button></div>`;
  document.getElementById('allow').onclick = async () => {
    const { pairedOrigins = [] } = await chrome.storage.local.get('pairedOrigins');
    if (!pairedOrigins.includes(origin)) await chrome.storage.local.set({ pairedOrigins: [...pairedOrigins, origin] });
    el.innerHTML = '<h2>Connected ✓</h2><p>You can close this window and return to WorkForce.</p>';
    setTimeout(() => window.close(), 900);
  };
  document.getElementById('deny').onclick = () => window.close();
} else if (mode === 'grant') {
  let origins = [];
  try { origins = JSON.parse(params.get('origins') || '[]').filter((o) => /^https?:\/\//.test(o)); } catch { origins = []; }
  el.innerHTML = `<h2>Allow WorkForce to work on these sites?</h2>
    <ul class="origin-list">${origins.map((o) => `<li>${esc(o.replace('/*', ''))}</li>`).join('')}</ul>
    <p>Employees will be able to read and act on these sites only within their permissions. Clicks, navigation and form input still require your approval unless you changed that.</p>
    <div class="actions"><button class="btn" id="deny">Cancel</button><button class="btn primary" id="allow">Grant access</button></div>`;
  document.getElementById('allow').onclick = async () => {
    const ok = await chrome.permissions.request({ origins });
    el.innerHTML = ok ? '<h2>Access granted ✓</h2><p>Return to WorkForce and run the task again.</p>' : '<h2>Access not granted</h2>';
    setTimeout(() => window.close(), 1200);
  };
  document.getElementById('deny').onclick = () => window.close();
} else {
  el.textContent = 'Nothing to approve.';
}
