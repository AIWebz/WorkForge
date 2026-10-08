import { esc, icon, toast, refreshIcons, sysIcon } from '../ui.js';
import { allSystems } from '../../extension/core/catalog.js';
import { engineFormHtml, bindEngineForm } from './settings.js';
import { startGeneration, systemsForForm } from './create.js';
import { systemPickerHtml, bindSystemPicker, openConnectDialog } from './systems.js';
import { bridge } from '../bridge.js';

const STEPS = ['Business', 'Employee', 'Systems', 'Deploy'];

export default async function onboarding(ctx) {
  const { el, app, navigate } = ctx;
  const saved = app.business || {};
  const state = {
    step: 0,
    business: { description: saved.description || '', automate: saved.automate || '', systems: [...(saved.systems || [])] },
    request: '',
    name: '',
  };

  const render = async () => {
    if (!ctx.isCurrent()) return;
    const s = state.step;
    el.innerHTML = `<div class="onb"><div class="onb-card">
      <a class="logo" href="#/"><img src="assets/img/logo.svg" alt="">WorkForge</a>
      <h1 style="margin-top:22px;font-size:28px">Let's build your first employee.</h1>
      <div class="stepper">${STEPS.map((label, i) => `<div class="st ${i === s ? 'active' : i < s ? 'done' : ''}"><span class="n">${i < s ? '✓' : i + 1}</span><span class="lbl">${label}</span></div>${i < STEPS.length - 1 ? '<div class="line"></div>' : ''}`).join('')}</div>
      <div id="step"></div>
    </div></div>`;
    const host = el.querySelector('#step');
    if (s === 0) await stepBusiness(host);
    if (s === 1) stepEmployee(host);
    if (s === 2) await stepSystems(host);
    if (s === 3) await stepDeploy(host);
    refreshIcons();
  };

  async function stepBusiness(host) {
    const b = state.business;
    const rows = await app.getConnections();
    const selected = new Set(b.systems);
    host.innerHTML = `<div class="form-grid">
      <label class="field"><span>What does your business do?</span><div class="input-icon">${icon('briefcase')}<input class="input" id="b-desc" value="${esc(b.description)}" placeholder="e.g. Online furniture store, B2B SaaS, real-estate agency…"></div></label>
      <label class="field"><span>What work would you like to automate?</span><div class="input-icon">${icon('workflow')}<input class="input" id="b-auto" value="${esc(b.automate)}" placeholder="e.g. Lead follow-up, customer support, invoicing…"></div></label>
      <div class="field"><span>Which systems do you work in?</span><span class="help">Employees work in these web apps in your browser, signed in as you.</span>
        <div class="mt-8">${systemPickerHtml(b.systems, { connections: rows })}</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="next">Continue ${icon('arrow-right')}</button></div>
    </div>`;
    bindSystemPicker(host, selected);
    host.querySelector('#next').onclick = async () => {
      b.description = host.querySelector('#b-desc').value.trim();
      b.automate = host.querySelector('#b-auto').value.trim();
      b.systems = [...selected];
      if (!b.description || !b.automate) return toast('Tell us what your business does and what to automate', 'error');
      await app.saveBusiness(b);
      app.events.emit({ type: 'business' });
      if (!state.request) {
        const names = systemsForForm(b.systems, rows).systems;
        state.request = `I need an employee to handle ${b.automate.charAt(0).toLowerCase()}${b.automate.slice(1)} for our business (${b.description}).${names.length ? ` We work in ${names.join(', ')}.` : ''}`;
      }
      state.step = 1;
      render();
    };
  }

  function stepEmployee(host) {
    host.innerHTML = `<div class="form-grid">
      <label class="field"><span>Describe the employee you need</span><textarea class="textarea" id="req" rows="7">${esc(state.request)}</textarea>
      <span class="help">Be specific: what triggers the work, which decisions it makes, which systems it works in, what needs your approval, and what it reports.</span></label>
      <label class="field"><span>Name (optional)</span><input class="input" id="nm" value="${esc(state.name)}" placeholder="e.g. Alex"></label>
      <div class="between"><button class="btn btn-ghost" id="back">${icon('arrow-left')} Back</button><button class="btn btn-primary" id="next">Continue ${icon('arrow-right')}</button></div>
    </div>`;
    host.querySelector('#back').onclick = () => { state.step = 0; render(); };
    host.querySelector('#next').onclick = () => {
      state.request = host.querySelector('#req').value.trim();
      state.name = host.querySelector('#nm').value.trim();
      if (state.request.length < 20) return toast('Describe the work in a bit more detail', 'error');
      state.step = 2;
      render();
    };
  }

  async function stepSystems(host) {
    const [engineForm, rows] = await Promise.all([engineFormHtml(), app.getConnections()]);
    const all = allSystems(rows);
    const connected = new Set(rows.map((r) => r.id));
    const mine = state.business.systems.filter((id) => all[id]);
    host.innerHTML = `<div class="form-grid">
      <div><h3>${icon('cpu')} Choose the AI engine</h3><p class="small muted mt-4">WorkForge's AI engine is an open-source model that runs on this computer's GPU. No account, no API key — it downloads once and your data never leaves this device.</p></div>
      <div class="card card-pad" style="background:var(--surface-2)">${engineForm}</div>
      <div><h3>${icon('app-window')} Your systems</h3><p class="small muted mt-4">Optional now — connect them any time from Systems. Employees open them in browser tabs with your login and ask before clicking or typing.</p>
        ${mine.length ? `<div class="col gap-6 mt-8">${mine.map((id) => `<div class="between" style="border:1px solid var(--border);border-radius:10px;padding:8px 12px;background:var(--surface)"><div class="row">${sysIcon(id, true, all[id].name)}<span class="small strong">${esc(all[id].name)}</span></div>${connected.has(id) ? '<span class="small s-ok">Connected</span>' : `<button class="btn btn-xs" data-connect="${esc(id)}">${icon('plus')} Connect</button>`}</div>`).join('')}</div>` : '<p class="help mt-8">You did not pick any systems. You can add them later in Systems.</p>'}
        ${bridge.paired ? '' : `<div class="callout mt-8">${icon('puzzle')}<div class="small">Employees need the WorkForge browser extension to work in these systems. <a href="#/extension" target="_blank" rel="noopener">Set it up</a> now or after generating.</div></div>`}
      </div>
      <div class="between"><button class="btn btn-ghost" id="back">${icon('arrow-left')} Back</button><button class="btn btn-primary" id="next">Continue ${icon('arrow-right')}</button></div>
    </div>`;
    host.querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => openConnectDialog(app, b.dataset.connect));
    bindEngineForm(host);
    host.querySelector('#back').onclick = () => { state.step = 1; render(); };
    host.querySelector('#next').onclick = async () => {
      const gpu = await app.engine.gpuInfo();
      if (!gpu.supported) return toast(gpu.reason, 'error');
      const picked = host.querySelector('[name=ai-model]:checked')?.value;
      if (picked) await app.saveAI({ model: picked, source: host.querySelector('#ai-source .active')?.dataset.src || 'mirror' });
      state.step = 3;
      render();
    };
  }

  async function stepDeploy(host) {
    const rows = await app.getConnections();
    const { systems, systemIds } = systemsForForm(state.business.systems, rows);
    host.innerHTML = `<div class="form-grid">
      <div class="callout">${icon('sparkles')}<div><strong>Ready to generate.</strong><div class="small mt-4">The AI engine will analyze your request, design the scripts and decision logic, configure memory, permissions and the systems it works in, and validate the employee. You review everything before deploying.</div></div></div>
      <pre class="light">${esc(state.request)}</pre>
      ${systemIds.length ? `<div class="row wrap">${systemIds.map((id, i) => `<span class="chip">${sysIcon(id, true, systems[i])}${esc(systems[i])}</span>`).join('')}</div>` : ''}
      <div class="between"><button class="btn btn-ghost" id="back">${icon('arrow-left')} Back</button><button class="btn btn-primary btn-lg" id="go">${icon('sparkles')} Generate employee</button></div>
    </div>`;
    host.querySelector('#back').onclick = () => { state.step = 2; render(); };
    host.querySelector('#go').onclick = () => {
      const job = startGeneration(app, { request: state.request, form: { name: state.name, systems, systemIds } });
      navigate(`/generate/${job}`);
    };
  }

  // A system connected from the Systems step updates its row in place (keeps the AI form as typed).
  ctx.watch?.(['connections'], async () => {
    if (state.step !== 2 || !ctx.isCurrent()) return;
    const ids = new Set((await app.getConnections()).map((r) => r.id));
    el.querySelectorAll('[data-connect]').forEach((b) => { if (ids.has(b.dataset.connect)) b.outerHTML = '<span class="small s-ok">Connected</span>'; });
  }, 300);
  await render();
}
