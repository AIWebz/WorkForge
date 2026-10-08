import { esc, icon, toast, refreshIcons, on, sysIcon } from '../ui.js';
import { CONNECTIONS } from '../../extension/core/catalog.js';
import { aiFormHtml, bindAiForm, unlockDialog } from './settings.js';
import { startGeneration } from './create.js';

const SYSTEM_CHIPS = [
  ['google', 'Google Workspace'], ['slack', 'Slack'], ['notion', 'Notion'], ['salesforce', 'Salesforce'],
  ['hubspot', 'HubSpot'], ['shopify', 'Shopify'], ['zendesk', 'Zendesk'], ['api', 'Other'],
];
const STEPS = ['Business', 'Employee', 'Systems', 'Deploy'];

export default async function onboarding({ el, app, navigate }) {
  const state = {
    step: 0,
    business: { name: '', description: '', automate: '', systems: [], ...(app.business || {}) },
    request: '',
    name: '',
  };

  const render = async () => {
    const s = state.step;
    el.innerHTML = `<div class="onb"><div class="onb-card">
      <a class="logo" href="#/"><img src="assets/img/logo.svg" alt="">WorkForge</a>
      <h1 style="margin-top:22px;font-size:28px">Let's build your first employee.</h1>
      <div class="stepper">${STEPS.map((label, i) => `<div class="st ${i === s ? 'active' : i < s ? 'done' : ''}"><span class="n">${i < s ? '✓' : i + 1}</span><span class="lbl">${label}</span></div>${i < STEPS.length - 1 ? '<div class="line"></div>' : ''}`).join('')}</div>
      <div id="step"></div>
    </div></div>`;
    const host = el.querySelector('#step');
    if (s === 0) stepBusiness(host);
    if (s === 1) stepEmployee(host);
    if (s === 2) await stepSystems(host);
    if (s === 3) await stepDeploy(host);
    refreshIcons();
  };

  function stepBusiness(host) {
    const b = state.business;
    host.innerHTML = `<div class="form-grid">
      <label class="field"><span>Company name</span><div class="input-icon">${icon('building-2')}<input class="input" id="b-name" value="${esc(b.name)}" placeholder="Acme Inc."></div></label>
      <label class="field"><span>What does your business do?</span><div class="input-icon">${icon('user-round')}<input class="input" id="b-desc" value="${esc(b.description)}" placeholder="e.g. E-commerce, SaaS, real estate, healthcare…"></div></label>
      <label class="field"><span>What work would you like to automate?</span><div class="input-icon">${icon('user-round')}<input class="input" id="b-auto" value="${esc(b.automate)}" placeholder="e.g. Lead generation, customer support, data analysis…"></div></label>
      <div class="field"><span>What systems do you currently use?</span><span class="help">Connect your tools so your employee can work with them.</span>
        <div class="tiles mt-8">${SYSTEM_CHIPS.map(([id, label]) => `<button class="tile ${b.systems.includes(label) ? 'selected' : ''}" data-sys="${label}">${id === 'api' ? `<span class="sys-icon" style="background:#eef0ff;color:var(--primary)">+</span>` : sysIcon(id)}${label}</button>`).join('')}</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="next">Continue ${icon('arrow-right')}</button></div>
    </div>`;
    on(host, 'click', '[data-sys]', (e, t) => {
      const v = t.dataset.sys;
      b.systems = b.systems.includes(v) ? b.systems.filter((x) => x !== v) : [...b.systems, v];
      t.classList.toggle('selected');
    });
    host.querySelector('#next').onclick = async () => {
      b.name = host.querySelector('#b-name').value.trim();
      b.description = host.querySelector('#b-desc').value.trim();
      b.automate = host.querySelector('#b-auto').value.trim();
      if (!b.description || !b.automate) return toast('Tell us what your business does and what to automate', 'error');
      await app.saveBusiness(b);
      if (!state.request) state.request = `I need an employee to handle ${b.automate.toLowerCase()} for our business (${b.description}).`;
      state.step = 1;
      render();
    };
  }

  function stepEmployee(host) {
    host.innerHTML = `<div class="form-grid">
      <label class="field"><span>Describe the employee you need</span><textarea class="textarea" id="req" rows="7">${esc(state.request)}</textarea>
      <span class="help">Be specific: what triggers the work, which decisions it makes, which systems it uses, what needs your approval, and what it reports.</span></label>
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
    const cfg = await app.db.getSetting('ai', {});
    const conns = await app.connectionMap();
    host.innerHTML = `<div class="form-grid">
      <div><h3>${icon('cpu')} Connect the AI engine</h3><p class="small muted mt-4">WorkForge runs in your browser and uses your own model provider key. It is stored in your local credential vault — never in the repository.</p></div>
      ${app.vault.locked ? `<div class="callout warn">${icon('lock')}<div>Vault locked. <button class="link-btn" id="unlock">Unlock</button></div></div>` : ''}
      <div class="card card-pad" style="background:var(--surface-2)">${aiFormHtml(cfg, !!app.vault.get('ai.apiKey'))}</div>
      <div><h3>${icon('plug')} Business systems</h3><p class="small muted mt-4">Optional now — you can connect them any time from Integrations. Employees will ask for approval before acting in them.</p>
      <div class="row wrap mt-8">${Object.entries(CONNECTIONS).map(([id, c]) => `<span class="chip">${sysIcon(id, true)}${esc(c.name)} ${conns[id]?.status === 'connected' ? '✓' : ''}</span>`).join('')}</div>
      <a class="link-btn mt-8" href="#/integrations" target="_blank" rel="noopener">${icon('external-link')} Open Integrations in a new tab</a></div>
      <div class="between"><button class="btn btn-ghost" id="back">${icon('arrow-left')} Back</button><button class="btn btn-primary" id="next">Continue ${icon('arrow-right')}</button></div>
    </div>`;
    host.querySelector('#unlock')?.addEventListener('click', () => unlockDialog(render));
    bindAiForm(host);
    host.querySelector('#back').onclick = () => { state.step = 1; render(); };
    host.querySelector('#next').onclick = async () => {
      if (!(await app.aiReady())) return toast('Save a working AI provider and key first (use Test connection).', 'error');
      state.step = 3;
      render();
    };
  }

  async function stepDeploy(host) {
    host.innerHTML = `<div class="form-grid">
      <div class="callout">${icon('sparkles')}<div><strong>Ready to generate.</strong><div class="small mt-4">The AI engine will analyze your request, design the scripts and decision logic, configure memory, permissions and tools, and validate the employee. You can review everything before deploying.</div></div></div>
      <pre class="light">${esc(state.request)}</pre>
      <div class="between"><button class="btn btn-ghost" id="back">${icon('arrow-left')} Back</button><button class="btn btn-primary btn-lg" id="go">${icon('sparkles')} Generate Employee</button></div>
    </div>`;
    host.querySelector('#back').onclick = () => { state.step = 2; render(); };
    host.querySelector('#go').onclick = () => {
      const job = startGeneration(app, { request: state.request, form: { name: state.name, systems: state.business.systems } });
      navigate(`/generate/${job}`);
    };
  }

  await render();
}
