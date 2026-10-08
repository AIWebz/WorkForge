import { esc, icon, toast, modal, confirmDialog, download, refreshIcons } from '../ui.js';
import { testEngine } from '../../extension/core/ai.js';
import { modelInfo } from '../../extension/core/engine.js';
import { STORE_NAMES } from '../../extension/core/db.js';
import { app, syncExtension } from '../state.js';
import { systemPickerHtml, bindSystemPicker } from './systems.js';

const SECTIONS = [['business', 'building-2', 'Business profile'], ['ai', 'cpu', 'AI Engine'], ['security', 'shield', 'Security'], ['data', 'database', 'Data & backup']];

export default async function settings(ctx) {
  const { el, params, navigate } = ctx;
  const section = params.section || 'ai';
  el.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Settings</h1><p>Workspace, AI engine, security and data.</p></div></div>
    <div class="tabs">${SECTIONS.map(([id, ic, label]) => `<a href="#/settings/${id}" class="${id === section ? 'active' : ''}">${label}</a>`).join('')}</div>
    <div id="section"></div></div>`;
  const host = el.querySelector('#section');
  if (section === 'business') return businessSection(host);
  if (section === 'security') return securitySection(host);
  if (section === 'data') return dataSection(host, navigate);
  return aiSection(host);
}

// ------------------------------------------------------------ business
async function businessSection(host) {
  const b = app.business || {};
  const rows = await app.getConnections();
  const selected = new Set(b.systems || []);
  host.innerHTML = `<div class="card card-pad form-grid" style="max-width:760px">
    <label class="field"><span>What does your business do?</span><textarea class="textarea" id="b-desc" rows="3" placeholder="e.g. Online furniture store selling to customers across Europe">${esc(b.description || '')}</textarea></label>
    <label class="field"><span>What work would you like to automate?</span><textarea class="textarea" id="b-auto" rows="3" placeholder="e.g. Lead follow-up, customer support, invoicing">${esc(b.automate || '')}</textarea></label>
    <div class="field"><span>Which systems do you work in?</span><span class="help">Used when generating employees. Connect them in <a href="#/systems">Systems</a> so employees can open them.</span>
      <div class="mt-8">${systemPickerHtml(b.systems || [], { connections: rows })}</div></div>
    <p class="help">This profile is stored as business memory for every employee you generate.</p>
    <div><button class="btn btn-primary" id="save">${icon('save')} Save</button></div>
  </div>`;
  bindSystemPicker(host, selected);
  host.querySelector('#save').onclick = async () => {
    await app.saveBusiness({
      description: host.querySelector('#b-desc').value.trim(),
      automate: host.querySelector('#b-auto').value.trim(),
      systems: [...selected],
    });
    app.events.emit({ type: 'business' });
    toast('Business profile saved', 'success');
  };
  refreshIcons();
}

// ------------------------------------------------------------ AI engine
/** Live status of the on-device engine. Nothing to configure — the model is chosen automatically. */
export async function engineStatusHtml() {
  const gpu = await app.engine.gpuInfo();
  const st = app.engine.status;
  const cfg = await app.getAI();
  let next = '';
  try { next = gpu.supported ? (await app.engine.candidates(cfg))[0] : ''; } catch { next = ''; }
  const model = st.model || next;
  const label = !gpu.supported ? 'Not available in this browser' : st.state === 'ready' ? 'Running on this device' : st.state === 'loading' ? 'Preparing…' : st.state === 'error' ? 'Could not start' : 'Ready to start';
  return `<div class="engine-status">
    <div class="between"><div class="row"><span class="engine-orb ${gpu.supported ? st.state : 'off'}"></span><div><div class="strong">${esc(label)}</div><div class="small muted">${gpu.supported ? `${esc(modelInfo(model).label)} · chosen automatically for your GPU` : esc(gpu.reason)}</div></div></div>
      ${gpu.supported ? `<span class="tiny muted mono">${cfg.source?.base ? 'served by this site' : 'open-model mirror'}</span>` : ''}</div>
    <div class="engine-progress mt-12" id="ai-progress" ${st.state === 'loading' ? '' : 'hidden'}><div class="meter"><span id="ai-bar" style="width:${Math.round((st.progress || 0) * 100)}%"></span></div><div class="tiny muted mt-4" id="ai-progress-text">${esc(st.text)}</div></div>
    ${st.state === 'error' ? `<div class="callout danger mt-12">${icon('alert-triangle')}<div class="small">${esc(st.text)}</div></div>` : ''}
    ${gpu.supported ? `<div class="row wrap mt-16"><button class="btn btn-primary" id="ai-prepare" ${st.state === 'ready' || st.state === 'loading' ? 'disabled' : ''}>${icon('download')} ${st.state === 'ready' ? 'Engine is running' : 'Prepare now'}</button><button class="btn btn-ghost" id="ai-delete">${icon('trash-2')} Free up space</button><span class="small muted" id="ai-status"></span></div>` : ''}
  </div>`;
}

export function bindEngineStatus(root, rerender) {
  const q = (sel) => root.querySelector(sel);
  const off = app.engine.onStatus((st) => {
    if (!root.isConnected) return off();
    const bar = q('#ai-bar');
    if (st.state !== 'loading' || !bar) { rerender && rerender(); return; }
    q('#ai-progress').hidden = false;
    bar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
    q('#ai-progress-text').textContent = st.text || '';
  });
  q('#ai-prepare')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await app.prepareEngine(); toast('AI engine is running on this device', 'success'); } catch (err) { if (err.code !== 'stopped') toast(err.message, 'error'); }
  });
  q('#ai-delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove the downloaded model from this browser? It downloads again automatically the next time an employee runs.', { confirm: 'Remove', danger: true }))) return;
    try { await app.engine.deleteCache(await app.getAI()); toast('Model removed from this browser'); rerender && rerender(); } catch (err) { toast(err.message, 'error'); }
  });
}

async function aiSection(host) {
  host.innerHTML = `<div class="grid-2" style="grid-template-columns:1.2fr 1fr;align-items:start">
    <div class="card card-pad" id="engine-box">${await engineStatusHtml()}</div>
    <div class="card card-pad col">
      <h3>${icon('cpu')} How it works</h3>
      <p class="small muted">WorkForge's AI engine is an open-source language model that runs on this computer's GPU, inside your browser. There's nothing to set up: it picks the best model your GPU can hold, downloads it once, and keeps it in the browser cache.</p>
      <p class="small muted">No AI provider, no account, no API key — prompts, files and results never leave this device.</p>
    </div>
  </div>`;
  const box = host.querySelector('#engine-box');
  const rerender = async () => { if (!box.isConnected) return; box.innerHTML = await engineStatusHtml(); bindEngineStatus(box, rerender); refreshIcons(); };
  bindEngineStatus(box, rerender);
  refreshIcons();
}

function securitySection(host) {
  const s = app.settings;
  host.innerHTML = `<div class="grid-2" style="align-items:start">
    <div class="card card-pad form-grid">
      <h3>${icon('shield-check')} Execution safeguards</h3>
      <div class="between"><div><div class="strong small">Require approval for every outbound action</div><div class="help">Overrides employee permissions: every click and every form input in your systems waits for your approval.</div></div><label class="toggle"><input type="checkbox" id="strict" ${s.approveAllOutbound ? 'checked' : ''}><span></span></label></div>
      <div class="callout">${icon('info')}<div class="small">Always enforced: employees only get the tools their scripts need, permission levels are checked on every call, unknown tools are blocked, employees can only open the systems they were given (other websites you allow are read-only), they never type into password fields, each employee only sees its own memory and granted collections, and every action is written to the audit log.</div></div>
    </div>
    <div class="card card-pad form-grid">
      <h3>${icon('lock')} No secrets to keep</h3>
      <p class="small muted">WorkForge stores no passwords, tokens or API keys. The AI engine runs on this device, and employees work in your systems through browser tabs that use your own signed-in session. Your data — employees, memory, files, logs — stays in this browser's storage (IndexedDB). Export it from Data &amp; backup.</p>
    </div>
  </div>`;
  host.querySelector('#strict').onchange = (e) => app.saveSecurity({ approveAllOutbound: e.target.checked }).then(() => { toast('Saved', 'success'); if (app.bridge.paired) syncExtension().catch(() => {}); });
  refreshIcons();
}

// ------------------------------------------------------------ data
function dataSection(host, navigate) {
  host.innerHTML = `<div class="grid-2" style="align-items:start">
    <div class="card card-pad form-grid">
      <h3>${icon('download')} Backup</h3>
      <p class="small muted">Export employees, memory, files, tasks, activity, approvals and reports as JSON. The downloaded AI model is not included (it stays in the browser cache).</p>
      <div class="row"><button class="btn" id="export">${icon('download')} Export backup</button><label class="btn">${icon('upload')} Import backup<input type="file" accept="application/json" id="import" hidden></label></div>
    </div>
    <div class="card card-pad form-grid">
      <h3 style="color:var(--danger)">${icon('trash-2')} Danger zone</h3>
      <p class="small muted">Delete all WorkForge data stored in this browser.</p>
      <div><button class="btn btn-danger" id="wipe">Delete all data</button></div>
    </div>
  </div>`;
  host.querySelector('#export').onclick = async () => {
    const out = { app: 'workforge', version: 1, exportedAt: new Date().toISOString(), stores: {} };
    for (const s of STORE_NAMES) out.stores[s] = await app.db.all(s);
    download(`workforge-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
  };
  host.querySelector('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'workforge' || !data.stores) throw new Error('Not a WorkForge backup');
      if (!(await confirmDialog('Import will merge the backup into your current data (records with the same id are replaced).', { confirm: 'Import' }))) return;
      for (const s of STORE_NAMES) if (Array.isArray(data.stores[s])) await app.db.bulkPut(s, data.stores[s]);
      await app.load();
      toast('Backup imported', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  host.querySelector('#wipe').onclick = async () => {
    if (!(await confirmDialog('This permanently deletes all employees, files, tasks and logs in this browser.', { confirm: 'Delete everything', danger: true }))) return;
    for (const s of STORE_NAMES) await app.db.clear(s);
    await app.engine.unload();
    await app.load();
    toast('All data deleted');
    navigate('/');
  };
}
