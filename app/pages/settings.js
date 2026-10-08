import { esc, icon, toast, modal, confirmDialog, download, refreshIcons } from '../ui.js';
import { testEngine } from '../../extension/core/ai.js';
import { MODELS, modelInfo } from '../../extension/core/engine.js';
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
// ------------------------------------------------------------ AI engine
/** Model picker + download/test controls. Used by Settings and onboarding. */
export async function engineFormHtml() {
  const cfg = await app.getAI();
  const gpu = await app.engine.gpuInfo();
  const hosted = await app.hostedModels();
  const src = cfg.sourceName;
  return `<div class="form-grid">
    ${gpu.supported ? '' : `<div class="callout danger">${icon('alert-triangle')}<div><strong>This browser can't run the AI engine.</strong><div class="small mt-4">${esc(gpu.reason)}</div></div></div>`}
    <div class="field"><span>Model</span>
      <div class="col gap-6">${MODELS.map((m) => `<label class="check model-opt" style="align-items:flex-start"><input type="radio" name="ai-model" value="${m.id}" ${m.id === cfg.model ? 'checked' : ''}><div><div class="strong">${esc(m.label)} <span class="tiny muted mono">${esc(m.id.replace(/-q4f16_1-MLC$/, ''))}</span></div><div class="help">${esc(m.note)} · needs about ${(m.vramMB / 1024).toFixed(1)} GB of GPU memory${hosted.includes(m.id) ? ' · <strong>hosted on this site</strong>' : ''}</div></div></label>`).join('')}</div>
    </div>
    <div class="field"><span>Download the model from</span>
      <div class="seg" id="ai-source">
        <button type="button" data-src="site" class="${src === 'site' ? 'active' : ''}" ${hosted.length ? '' : 'disabled title="Enable model hosting in the GitHub Pages workflow first"'}>This site</button>
        <button type="button" data-src="mirror" class="${src !== 'site' ? 'active' : ''}">Public model mirror</button>
      </div>
      <span class="help">${hosted.length ? `This site hosts: ${hosted.map(esc).join(', ')}.` : 'This site does not host model weights yet — see “Self-host the model” in the README. Until then weights download once from the public open-model mirror (Hugging Face).'} Weights are cached by your browser; nothing you type is sent anywhere.</span>
    </div>
    <div class="engine-progress" id="ai-progress" hidden><div class="meter"><span id="ai-bar" style="width:0%"></span></div><div class="tiny muted mt-4" id="ai-progress-text"></div></div>
    <div class="row wrap"><button class="btn btn-primary" id="ai-save">${icon('save')} Save</button><button class="btn" id="ai-load" ${gpu.supported ? '' : 'disabled'}>${icon('download')} Load &amp; test</button><button class="btn btn-ghost" id="ai-delete">${icon('trash-2')} Remove downloaded model</button><span class="small muted" id="ai-status"></span></div>
  </div>`;
}

export function bindEngineForm(root, onSaved) {
  const q = (sel) => root.querySelector(sel);
  let source = q('#ai-source .active')?.dataset.src || 'mirror';
  root.querySelectorAll('#ai-source [data-src]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    source = b.dataset.src;
    root.querySelectorAll('#ai-source [data-src]').forEach((x) => x.classList.toggle('active', x === b));
  }));
  const status = (t, cls = 'muted') => { q('#ai-status').className = `small ${cls}`; q('#ai-status').textContent = t; };
  const model = () => q('[name=ai-model]:checked')?.value;
  const save = async () => { await app.saveAI({ model: model(), source }); return app.getAI(); };
  const off = app.engine.onStatus((st) => {
    const bar = q('#ai-bar');
    if (!bar) return off();
    q('#ai-progress').hidden = st.state !== 'loading';
    bar.style.width = `${Math.round((st.progress || 0) * 100)}%`;
    q('#ai-progress-text').textContent = st.text || '';
  });
  q('#ai-save').onclick = async () => {
    await save();
    status('Saved', 's-ok');
    toast(`AI engine: ${modelInfo(model()).label}`, 'success');
    onSaved && onSaved();
  };
  q('#ai-load').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    status('Loading the model — the first time downloads it to this browser…');
    try {
      const cfg = await save();
      const r = await testEngine(cfg);
      status(r.ok ? `Running on this device · ${modelInfo(cfg.model).label}` : `Model answered: “${r.text}”`, r.ok ? 's-ok' : 's-wait');
      onSaved && onSaved();
    } catch (err) { status(err.message, 's-err'); } finally { btn.disabled = false; }
  };
  q('#ai-delete').onclick = async () => {
    if (!(await confirmDialog('Remove the downloaded model from this browser? It downloads again the next time an employee runs.', { confirm: 'Remove', danger: true }))) return;
    try { await app.engine.deleteCache(await app.getAI()); status('Removed from this browser'); } catch (err) { status(err.message, 's-err'); }
  };
}

async function aiSection(host) {
  host.innerHTML = `<div class="grid-2" style="grid-template-columns:1.3fr 1fr;align-items:start">
    <div class="card card-pad">${await engineFormHtml()}</div>
    <div class="card card-pad col">
      <h3>${icon('cpu')} How the AI engine runs</h3>
      <p class="small muted">The AI engine is an open-source language model that runs <strong>on this computer's GPU</strong>, inside your browser (WebGPU). There is no AI provider, no account and no API key.</p>
      <ul class="small muted" style="padding-left:18px;margin:0">
        <li>The model is downloaded once and cached by the browser. Self-host it on your GitHub Pages site to serve it from your own repository.</li>
        <li>Generation (analysis and architecture) and every script step run through this engine. Answers are constrained to valid JSON tool calls, so small models stay reliable.</li>
        <li>Prompts, files and results never leave this device.</li>
        <li>Bigger models give better results but need more GPU memory. On GPUs without 16-bit shader support WorkForge automatically uses the 32-bit build.</li>
      </ul>
    </div>
  </div>`;
  bindEngineForm(host);
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
