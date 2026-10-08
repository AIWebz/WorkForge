// Approval window for pairing a WorkForge app origin and for granting site access.
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const el = document.getElementById('content');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (mode === 'pair') {
  const origin = params.get('origin') || '';
  el.innerHTML = `<h2>Connect this WorkForge workspace?</h2>
    <p class="origin">${esc(origin)}</p>
    <p>Only allow this if it is <strong>your</strong> WorkForge app. Once connected, it can:</p>
    <ul class="perm-list">
      <li>Sync your employees, knowledge files, memory, connected systems and approval settings into the extension</li>
      <li>Receive your AI engine key, only if you turned on sharing it with the extension in the app's Settings (kept in session storage, cleared when the browser closes)</li>
      <li>See the titles and addresses of your open tabs when you pick one for a task</li>
      <li>Open your connected systems (Gmail, HubSpot…) in a new working tab, on sites you allowed</li>
      <li>Read pages, navigate, click and type in working tabs, only on sites you allowed and within each employee's permissions</li>
    </ul>
    <p class="tiny muted">WorkForge never sees your passwords, and employees cannot type into password fields.</p>
    <div class="actions"><button class="btn" id="deny">Deny</button><button class="btn primary" id="allow">Allow</button></div>`;
  document.getElementById('allow').onclick = async () => {
    const { pairedOrigins = [] } = await chrome.storage.local.get('pairedOrigins');
    if (!pairedOrigins.includes(origin)) await chrome.storage.local.set({ pairedOrigins: [...pairedOrigins, origin] });
    el.innerHTML = '<h2>Connected</h2><p>You can close this window and return to WorkForge.</p>';
    setTimeout(() => window.close(), 900);
  };
  document.getElementById('deny').onclick = () => window.close();
} else if (mode === 'grant') {
  let origins = [];
  try { origins = JSON.parse(params.get('origins') || '[]').filter((o) => /^https?:\/\//.test(o)); } catch { origins = []; }
  el.innerHTML = `<h2>Allow WorkForge to work on these sites?</h2>
    <ul class="origin-list">${origins.map((o) => `<li>${esc(o.replace('/*', ''))}</li>`).join('')}</ul>
    <p>Employees will be able to read and act on these sites in your signed-in browser, only within their permissions. Clicks and typing need your approval unless you changed that for the employee.</p>
    <div class="actions"><button class="btn" id="deny">Cancel</button><button class="btn primary" id="allow">Grant access</button></div>`;
  document.getElementById('allow').onclick = async () => {
    const ok = await chrome.permissions.request({ origins });
    el.innerHTML = ok ? '<h2>Access granted</h2><p>Return to WorkForge and run the task again.</p>' : '<h2>Access not granted</h2><p>Employees cannot work on these sites until you allow them.</p>';
    setTimeout(() => window.close(), 1200);
  };
  document.getElementById('deny').onclick = () => window.close();
} else {
  el.textContent = 'Nothing to approve.';
}
