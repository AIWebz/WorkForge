import { esc, icon, refreshIcons, toast, statusBadge, loadScript, download } from '../ui.js';
import { bridge } from '../bridge.js';
import { syncExtension } from '../state.js';

const STEPS = [
  ['download', 'Install the WorkForce extension', 'Download the extension package below (or use the <code>extension/</code> folder of this repository), unzip it, open <code>chrome://extensions</code>, enable <strong>Developer mode</strong> and click <strong>Load unpacked</strong>.'],
  ['pin', 'Pin it to the browser', 'Click the puzzle icon in the toolbar and pin <strong>WorkForce</strong> so it is one click away.'],
  ['link', 'Connect it to this workspace', 'Click <strong>Connect extension</strong> on this page and approve the request. Your employees, knowledge and (optionally) credentials sync to the extension.'],
  ['globe', 'Open a website', 'Go to the site where the work happens — LinkedIn, Salesforce, Google Sheets, your admin panel…'],
  ['users', 'Select an AI employee', 'Open the WorkForce side panel and choose which employee should work there. Only employees with browser access are available.'],
  ['play', 'Select the tab and start', 'Choose the browser tab, describe the job, approve site access, and click <strong>Start Working</strong>.'],
];

export default async function extensionPage(ctx) {
  const { el, app } = ctx;
  const render = async () => {
    if (!ctx.isCurrent()) return;
    await bridge.detect();
    const ghRepo = guessRepo();
    el.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Browser Extension</h1><p>Let your AI employees work inside the browser tabs you choose — using the same employee architecture, AI engine, permissions and approvals as the app.</p></div></div>
      <div class="grid-2" style="grid-template-columns: 1.4fr 1fr; align-items:start">
        <div class="col gap-16">
          <div class="card card-pad">
            <div class="between"><div class="row">${icon('puzzle', 'i-lg')}<div><h3>Extension status</h3><div class="small muted">${bridge.available ? `Detected · v${esc(bridge.version || '')}` : 'Not detected on this page'}</div></div></div>
            ${statusBadge(bridge.paired ? 'connected' : bridge.available ? 'pending' : 'disconnected', bridge.paired ? 'Connected' : bridge.available ? 'Awaiting connection' : 'Not installed')}</div>
            <div class="row wrap mt-16">
              ${bridge.available && !bridge.paired ? `<button class="btn btn-primary" id="pair">${icon('link')} Connect extension</button>` : ''}
              ${bridge.paired ? `<button class="btn btn-primary" id="sync">${icon('refresh-cw')} Sync now</button><button class="btn" id="unpair">${icon('unlink')} Disconnect</button>` : ''}
              ${!bridge.available ? `<button class="btn" id="recheck">${icon('refresh-cw')} Check again</button>` : ''}
            </div>
            ${!bridge.available ? `<p class="help mt-12">After loading the extension, reload this page. The extension activates automatically on <code>*.github.io</code> and <code>localhost</code>. For a custom domain, open the extension side panel → Settings → “Add WorkForce app address” and enter <code>${esc(location.origin)}</code>.</p>` : ''}
            ${bridge.paired ? `<p class="help mt-12">Credentials sharing: <strong>${app.settings.shareCredentialsWithExtension ? 'on' : 'off'}</strong> (Settings → Security). Shared secrets are kept in the extension's session storage and cleared when the browser closes.</p>` : ''}
          </div>
          <div class="card card-pad"><h3 class="mb-16">How to install and use it</h3><div class="install-steps">
            ${STEPS.map(([ic, t, d], i) => `<div class="install-step"><span class="n">${i + 1}</span><div><div class="strong small row gap-6">${icon(ic)}${t}</div><p class="small muted mt-4">${d}</p></div></div>`).join('')}
          </div></div>
        </div>
        <div class="col gap-16">
          <div class="card card-pad col">
            <h3>${icon('package')} Get the extension</h3>
            <p class="small muted">The extension is part of this repository. Chrome Web Store publishing is not possible from GitHub-only hosting, so you load it as an unpacked extension (Chrome, Edge, Brave, Arc — Chromium 116+).</p>
            <button class="btn btn-primary" id="zip">${icon('download')} Download extension (.zip)</button>
            ${ghRepo ? `<a class="btn" href="https://github.com/${esc(ghRepo)}/archive/refs/heads/main.zip">${icon('git-branch')} Download repository ZIP</a>` : ''}
            <div class="small muted">Then: <span class="kbd">chrome://extensions</span> → Developer mode → <strong>Load unpacked</strong> → select the unzipped <code>workforce-extension</code> folder.</div>
          </div>
          <div class="card card-pad col">
            <h3>${icon('shield-check')} What the extension can do</h3>
            <ul class="small muted" style="padding-left:18px;margin:0;display:flex;flex-direction:column;gap:6px">
              <li>Works only in the tab you pick, after you grant that site — never all sites by default.</li>
              <li>Each browser action is checked against the employee's permissions (read, navigate, click, form input, extract). Clicks, navigation and form input require approval unless you change them.</li>
              <li>Never reads or types into password fields.</li>
              <li>Relays API calls for services that block web pages (HubSpot, Notion, Shopify, Zendesk) — only from this paired workspace.</li>
              <li>Every action is logged and synced back to Activity.</li>
            </ul>
          </div>
          <div class="card card-pad col">
            <h3>${icon('git-merge')} Same employee, same engine</h3>
            <div class="small muted">Employee → AI Engine → Generated Scripts → Browser Tool → Current Tab → Result → AI Engine → Next Script. The extension runs the exact same runtime modules (<code>extension/core</code>) the app uses.</div>
          </div>
        </div>
      </div></div>`;
    el.querySelector('#pair')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.innerHTML = '<span class="spinner sm"></span> Approve in the extension window…';
      try {
        const r = await bridge.pair();
        if (r.paired) { toast('Extension connected', 'success'); await syncExtension(); } else toast('Connection was not approved', 'error');
      } catch (err) { toast(err.message, 'error'); }
      render();
    });
    el.querySelector('#sync')?.addEventListener('click', async () => {
      try { await syncExtension(); toast('Synced with extension', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    el.querySelector('#unpair')?.addEventListener('click', async () => { await bridge.unpair(); render(); });
    el.querySelector('#recheck')?.addEventListener('click', render);
    el.querySelector('#zip').onclick = buildZip;
    refreshIcons();
  };
  const off = bridge.on(() => render());
  ctx.cleanup(off);
  await render();
}

function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return '';
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return repo ? `${m[1]}/${repo}` : `${m[1]}/${m[1]}.github.io`;
}

async function buildZip(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await loadScript('assets/vendor/jszip.min.js');
    const list = await (await fetch('extension/files.json', { cache: 'no-store' })).json();
    const zip = new window.JSZip();
    const folder = zip.folder('workforce-extension');
    for (const path of list.files) {
      const res = await fetch(`extension/${path}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Missing extension file ${path}`);
      folder.file(path, await res.blob());
    }
    download('workforce-extension.zip', await zip.generateAsync({ type: 'blob' }));
    toast('Extension downloaded — unzip it and use “Load unpacked”', 'success');
  } catch (err) {
    toast(`Could not build the ZIP: ${err.message}`, 'error');
  } finally { btn.disabled = false; }
}
