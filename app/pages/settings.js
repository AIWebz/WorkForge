import { esc, icon, toast, modal, confirmDialog, download, refreshIcons } from '../ui.js';
import { PROVIDERS, testConnection } from '../../extension/core/ai.js';
import { STORE_NAMES } from '../../extension/core/db.js';
import { app } from '../state.js';
import { vault } from '../vault.js';

const SECTIONS = [['business', 'building-2', 'Business profile'], ['ai', 'cpu', 'AI Engine'], ['security', 'shield', 'Security & credentials'], ['data', 'database', 'Data & backup']];

export default async function settings(ctx) {
  const { el, params, navigate } = ctx;
  const section = params.section || 'ai';
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Settings</h1><p>Workspace, AI engine, security and data.</p></div></div>
    <div class="tabs">${SECTIONS.map(([id, ic, label]) => `<a href="#/settings/${id}" class="${id === section ? 'active' : ''}">${label}</a>`).join('')}</div>
    <div id="section"></div></div>`;
  const host = el.querySelector('#section');
  if (section === 'business') return businessSection(host);
  if (section === 'security') return securitySection(host, ctx);
  if (section === 'data') return dataSection(host, navigate);
  return aiSection(host);
}

// ------------------------------------------------------------ business
function businessSection(host) {
  const b = app.business || {};
  host.innerHTML = `<div class="card card-pad form-grid" style="max-width:760px">
    <label class="field"><span>Company name</span><input class="input" id="b-name" value="${esc(b.name || '')}" placeholder="Acme Inc."></label>
    <label class="field"><span>What does your business do?</span><textarea class="textarea" id="b-desc" rows="3">${esc(b.description || '')}</textarea></label>
    <label class="field"><span>What work would you like to automate?</span><textarea class="textarea" id="b-auto" rows="3">${esc(b.automate || '')}</textarea></label>
    <label class="field"><span>Systems you use (comma separated)</span><input class="input" id="b-sys" value="${esc((b.systems || []).join(', '))}"></label>
    <p class="help">This profile is stored as business memory for every employee you generate.</p>
    <div><button class="btn btn-primary" id="save">${icon('save')} Save</button></div>
  </div>`;
  host.querySelector('#save').onclick = async () => {
    await app.saveBusiness({
      name: host.querySelector('#b-name').value.trim(), description: host.querySelector('#b-desc').value.trim(),
      automate: host.querySelector('#b-auto').value.trim(), systems: host.querySelector('#b-sys').value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    app.events.emit({ type: 'business' });
    toast('Business profile saved', 'success');
  };
}

// ------------------------------------------------------------ AI engine
export function aiFormHtml(cfg, hasKey) {
  const p = cfg.provider || 'anthropic';
  const def = PROVIDERS[p];
  return `<div class="form-grid">
    <label class="field"><span>Provider</span><select class="select" id="ai-provider">${Object.entries(PROVIDERS).map(([id, x]) => `<option value="${id}" ${id === p ? 'selected' : ''}>${x.label}</option>`).join('')}</select></label>
    <div class="form-row">
      <label class="field"><span>Model</span><input class="input" id="ai-model" list="ai-models" value="${esc(cfg.model || def.defaultModel)}" placeholder="${p === 'anthropic' ? 'claude-opus-5-5' : 'model id'}"><datalist id="ai-models">${def.models.map((m) => `<option value="${m}">`).join('')}</datalist></label>
      <label class="field" ${p === 'anthropic' ? '' : 'hidden'} id="ai-effort-wrap"><span>Reasoning effort</span><select class="select" id="ai-effort">${['', 'low', 'medium', 'high', 'xhigh'].map((x) => `<option value="${x}" ${cfg.effort === x ? 'selected' : ''}>${x || 'Model default'}</option>`).join('')}</select></label>
    </div>
    <label class="field" id="ai-base-wrap" ${p === 'anthropic' ? 'hidden' : ''}><span>Base URL</span><input class="input" id="ai-base" value="${esc(cfg.baseUrl || def.baseUrl)}" placeholder="https://…/v1"><span class="help">OpenAI-compatible endpoints (OpenAI, OpenRouter, Groq, a local Ollama with OLLAMA_ORIGINS set…) must allow browser requests.</span></label>
    <label class="field"><span>API key</span><input class="input" type="password" id="ai-key" autocomplete="off" placeholder="${hasKey ? '•••••••• saved in vault — leave blank to keep' : def.keyHint}"><span class="help">Stored only in your browser's credential vault (${vault.mode}) and sent only to the provider above. Never commit keys to your repository.</span></label>
    <div class="row"><button class="btn" id="ai-test">${icon('plug-zap')} Test connection</button><button class="btn btn-primary" id="ai-save">${icon('save')} Save</button><span class="small muted" id="ai-status"></span></div>
  </div>`;
}

export function bindAiForm(root, onSaved) {
  const q = (s) => root.querySelector(s);
  q('#ai-provider').addEventListener('change', () => {
    const p = q('#ai-provider').value;
    const def = PROVIDERS[p];
    q('#ai-model').value = def.defaultModel;
    q('#ai-models').innerHTML = def.models.map((m) => `<option value="${m}">`).join('');
    q('#ai-base').value = def.baseUrl;
    q('#ai-base-wrap').hidden = p === 'anthropic';
    q('#ai-effort-wrap').hidden = p !== 'anthropic';
    q('#ai-key').placeholder = def.keyHint;
  });
  const read = async () => {
    const provider = q('#ai-provider').value;
    const cfg = { provider, model: q('#ai-model').value.trim(), baseUrl: provider === 'anthropic' ? '' : q('#ai-base').value.trim(), effort: provider === 'anthropic' ? q('#ai-effort').value : '' };
    const typed = q('#ai-key').value.trim();
    const apiKey = typed || vault.get('ai.apiKey') || '';
    return { cfg, apiKey, typed };
  };
  const status = (t, cls = 'muted') => { q('#ai-status').className = `small ${cls}`; q('#ai-status').textContent = t; };
  q('#ai-test').onclick = async () => {
    if (vault.locked) return unlockDialog();
    const { cfg, apiKey } = await read();
    status('Testing…');
    try {
      const r = await testConnection({ ...cfg, apiKey });
      status(r.ok ? `Connected · ${r.model}` : `Responded: “${r.text}”`, r.ok ? 's-ok' : 's-wait');
    } catch (e) { status(e.message, 's-err'); }
  };
  q('#ai-save').onclick = async () => {
    if (vault.locked) return unlockDialog();
    const { cfg, typed } = await read();
    if (!cfg.model) return toast('Choose a model', 'error');
    await app.saveAI(cfg, typed ? typed : undefined);
    q('#ai-key').value = '';
    q('#ai-key').placeholder = '•••••••• saved in vault — leave blank to keep';
    status('Saved', 's-ok');
    toast('AI engine saved', 'success');
    onSaved && onSaved();
  };
}

async function aiSection(host) {
  const cfg = await app.db.getSetting('ai', {});
  host.innerHTML = `<div class="grid-2" style="grid-template-columns:1.3fr 1fr;align-items:start">
    <div class="card card-pad">${vault.locked ? `<div class="callout warn mb-16">${icon('lock')}<div>The credential vault is locked. <button class="link-btn" id="unlock">Unlock</button></div></div>` : ''}${aiFormHtml(cfg, !!vault.get('ai.apiKey'))}</div>
    <div class="card card-pad col">
      <h3>${icon('cpu')} How the AI engine runs</h3>
      <p class="small muted">WorkForce is a static web app. The AI engine runs in this browser tab and calls your model provider directly with your key — there is no WorkForce server in between.</p>
      <ul class="small muted" style="padding-left:18px;margin:0">
        <li>Generation: requirement analysis + architecture design calls.</li>
        <li>Execution: one model turn per step; tools run locally or against your connected systems.</li>
        <li>Usage is billed by your provider to your account. Token counts are recorded per task.</li>
        <li>Claude models are called with the <code>anthropic-dangerous-direct-browser-access</code> header, which is required for browser-side use. Use a key with spend limits.</li>
      </ul>
    </div>
  </div>`;
  host.querySelector('#unlock')?.addEventListener('click', () => unlockDialog(() => aiSection(host)));
  bindAiForm(host);
  refreshIcons();
}

// ------------------------------------------------------------ security
function securitySection(host, ctx) {
  const s = app.settings;
  host.innerHTML = `<div class="grid-2" style="align-items:start">
    <div class="card card-pad form-grid">
      <h3>${icon('key-round')} Credential vault</h3>
      <p class="small muted">API keys and tokens are never stored in source code or the database. Choose where this browser keeps them:</p>
      ${[['session', 'Session only', 'Cleared when this tab closes. Most private; re-enter keys each session.'], ['encrypted', 'Encrypted with a passphrase', 'AES-256-GCM in local storage, key derived with PBKDF2 (310k iterations). Unlock once per session.'], ['device', 'This device (unencrypted)', 'Convenient for a personal machine. Anyone with access to this browser profile can read the keys.']]
    .map(([id, t, d]) => `<label class="check" style="align-items:flex-start"><input type="radio" name="vmode" value="${id}" ${vault.mode === id ? 'checked' : ''}><div><div class="strong">${t}</div><div class="help">${d}</div></div></label>`).join('')}
      <label class="field" id="pass-wrap" hidden><span>New passphrase</span><input class="input" type="password" id="pass" autocomplete="new-password" placeholder="At least 8 characters"></label>
      <div class="row"><button class="btn btn-primary" id="apply-mode">Apply</button>${vault.mode === 'encrypted' ? `<button class="btn" id="lock">${icon(vault.locked ? 'unlock' : 'lock')} ${vault.locked ? 'Unlock' : 'Lock now'}</button>` : ''}</div>
      <p class="help">Current: <strong>${vault.mode}</strong>${vault.locked ? ' (locked)' : ''} · ${vault.locked ? '?' : Object.keys(vault.getAll() || {}).length} secret(s) stored.</p>
    </div>
    <div class="card card-pad form-grid">
      <h3>${icon('shield-check')} Execution safeguards</h3>
      <div class="between"><div><div class="strong small">Require approval for every outbound action</div><div class="help">Overrides employee permissions: every send / write / create / click / form input waits for approval.</div></div><label class="toggle"><input type="checkbox" id="strict" ${s.approveAllOutbound ? 'checked' : ''}><span></span></label></div>
      <div class="between"><div><div class="strong small">Share credentials with the browser extension</div><div class="help">When paired, the extension receives the AI key and system tokens (kept in its session storage) so employees can run in tabs.</div></div><label class="toggle"><input type="checkbox" id="share" ${s.shareCredentialsWithExtension ? 'checked' : ''}><span></span></label></div>
      <div class="callout">${icon('info')}<div class="small">Always enforced: employees only get tools their scripts need, permission levels are checked on every call, unknown tools are blocked, browser navigation is limited to allowed domains, each employee only sees its own memory and granted collections, and every action is written to the audit log.</div></div>
    </div>
  </div>`;
  const pw = host.querySelector('#pass-wrap');
  host.querySelectorAll('[name=vmode]').forEach((r) => r.addEventListener('change', () => { pw.hidden = r.value !== 'encrypted' || !r.checked; }));
  host.querySelector('#apply-mode').onclick = async () => {
    const mode = host.querySelector('[name=vmode]:checked').value;
    try {
      if (vault.locked) return unlockDialog(() => securitySection(host, ctx));
      await vault.setMode(mode, host.querySelector('#pass').value);
      toast(`Vault mode: ${mode}`, 'success');
      securitySection(host, ctx);
    } catch (e) { toast(e.message, 'error'); }
  };
  host.querySelector('#lock')?.addEventListener('click', () => {
    if (vault.locked) unlockDialog(() => securitySection(host, ctx));
    else { vault.lock(); securitySection(host, ctx); }
  });
  host.querySelector('#strict').onchange = (e) => app.saveSecurity({ approveAllOutbound: e.target.checked }).then(() => toast('Saved', 'success'));
  host.querySelector('#share').onchange = (e) => app.saveSecurity({ shareCredentialsWithExtension: e.target.checked }).then(() => toast('Saved', 'success'));
  refreshIcons();
}

export function unlockDialog(after) {
  modal({
    title: 'Unlock credential vault',
    subtitle: 'Your API keys are encrypted with your passphrase.',
    body: '<label class="field"><span>Passphrase</span><input class="input" type="password" id="unlock-pass" autocomplete="current-password"></label>',
    actions: [
      { label: 'Cancel' },
      { label: 'Unlock', primary: true, icon: 'unlock', onClick: async (m) => { await vault.unlock(m.querySelector('#unlock-pass').value); toast('Vault unlocked', 'success'); after && after(); } },
    ],
    onMount(m, close) {
      m.querySelector('#unlock-pass').addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        try { await vault.unlock(e.target.value); close(); toast('Vault unlocked', 'success'); after && after(); } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

// ------------------------------------------------------------ data
function dataSection(host, navigate) {
  host.innerHTML = `<div class="grid-2" style="align-items:start">
    <div class="card card-pad form-grid">
      <h3>${icon('download')} Backup</h3>
      <p class="small muted">Export employees, memory, files, tasks, activity, approvals and reports as JSON. Credentials are never included.</p>
      <div class="row"><button class="btn" id="export">${icon('download')} Export backup</button><label class="btn">${icon('upload')} Import backup<input type="file" accept="application/json" id="import" hidden></label></div>
    </div>
    <div class="card card-pad form-grid">
      <h3 style="color:var(--danger)">${icon('trash-2')} Danger zone</h3>
      <p class="small muted">Delete all WorkForce data stored in this browser, including credentials.</p>
      <div><button class="btn btn-danger" id="wipe">Delete all data</button></div>
    </div>
  </div>`;
  host.querySelector('#export').onclick = async () => {
    const out = { app: 'workforce', version: 1, exportedAt: new Date().toISOString(), stores: {} };
    for (const s of STORE_NAMES) out.stores[s] = await app.db.all(s);
    download(`workforce-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
  };
  host.querySelector('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'workforce' || !data.stores) throw new Error('Not a WorkForce backup');
      if (!(await confirmDialog('Import will merge the backup into your current data (records with the same id are replaced).', { confirm: 'Import' }))) return;
      for (const s of STORE_NAMES) if (Array.isArray(data.stores[s])) await app.db.bulkPut(s, data.stores[s]);
      await app.load();
      toast('Backup imported', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  host.querySelector('#wipe').onclick = async () => {
    if (!(await confirmDialog('This permanently deletes all employees, files, tasks, logs and credentials in this browser.', { confirm: 'Delete everything', danger: true }))) return;
    for (const s of STORE_NAMES) await app.db.clear(s);
    await vault.wipe();
    await app.load();
    toast('All data deleted');
    navigate('/');
  };
}
