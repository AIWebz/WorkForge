import { icon, esc, sysIcon } from '../ui.js';
import { SYSTEMS } from '../../extension/core/catalog.js';

const FEATURES = [
  ['layers', 'Script architecture', 'Each employee is a set of generated scripts with inputs, outputs, decision logic and failure handling.'],
  ['cpu', 'On-device AI engine', 'An open-source model runs on your own GPU. No AI provider, no account, no API key.'],
  ['app-window', 'Works in your web apps', 'Employees use Gmail, HubSpot, Zendesk and the rest through browser tabs signed in as you.'],
  ['shield-check', 'Approval gates', 'Clicks and form input wait in the Approval Center until you approve, edit or reject them.'],
  ['file-text', 'File knowledge', 'PDF, Word, Excel, CSV, JSON and Markdown become searchable knowledge, parsed in your browser.'],
  ['git-merge', 'Decision logic', 'The engine runs scripts in sequence or by condition and chooses the next step from real results.'],
  ['message-square', 'Plain-language edits', '“Add a three-day follow-up.” The engine changes the actual architecture, with version history.'],
  ['activity', 'Full audit trail', 'Every script, page action, decision and approval is recorded in the activity log.'],
];

const STRIP = ['gmail', 'google_sheets', 'slack', 'hubspot', 'salesforce', 'zendesk', 'shopify', 'notion', 'linkedin', 'jira', 'stripe', 'google_calendar'];

export default async function landing({ el, app }) {
  const started = !!app.business || (await app.db.all('employees')).length > 0;
  const cta = started ? '#/create' : '#/onboarding';
  el.innerHTML = `<div class="landing">
    <nav class="l-nav">
      <a class="logo" href="#/"><img src="assets/img/logo.svg" alt="">WorkForge</a>
      <div class="l-links"><a href="#how">How it works</a><a href="#features">Employees</a><a href="#systems">Systems</a><a href="#engine">AI engine</a><a href="#/extension">Extension</a></div>
      <div class="row"><a class="btn btn-ghost btn-sm" href="#/dashboard">Open app</a><a class="btn btn-primary btn-sm" href="${cta}">Create employee</a></div>
    </nav>

    <section class="l-hero">
      <div>
        <span class="eyebrow"><span class="status-dot" style="background:var(--ember)"></span>AI employees that run on your machine</span>
        <h1>Build the AI employee your business <em>actually</em> needs.</h1>
        <p class="lead">Describe the work. WorkForge's on-device AI engine designs the employee — scripts, decision logic, memory and permissions — and runs it inside the web apps you already use.</p>
        <div class="row mt-24 wrap"><a class="btn btn-primary btn-lg" href="${cta}">Create an employee ${icon('arrow-right')}</a><a class="btn btn-lg" href="#how">See how it works</a></div>
        <ul class="l-facts">
          <li>${icon('check')} No API keys, no AI provider — the model runs on your GPU</li>
          <li>${icon('check')} Works in Gmail, HubSpot, Zendesk… with your own login</li>
          <li>${icon('check')} Every click and form entry waits for your approval</li>
        </ul>
      </div>
      <div class="preview" aria-label="Illustration of an employee working">
        <div class="pv-side">
          <div class="strong" style="color:var(--text)"><img src="assets/img/logo.svg" width="14" alt="">WorkForge</div>
          <div class="pv-label">Operate</div><div>${icon('layout-dashboard')}Overview</div><div class="on">${icon('users')}Employees</div><div>${icon('list-checks')}Tasks</div><div>${icon('shield-check')}Approvals</div>
          <div class="pv-label">Build</div><div>${icon('plus')}Create</div><div>${icon('folder')}Files</div><div>${icon('app-window')}Systems</div>
        </div>
        <div class="pv-main">
          <div class="pv-top"><span>Employees / <b>Alex</b></span><span class="mono">example run</span></div>
          <div class="pv-body">
            <div class="pv-emp"><span class="avatar avatar-sm" style="background:#34379a">A</span><div><div class="strong">Alex · Lead Operations</div><div class="tiny muted">“Reply to new leads in Gmail, log them in HubSpot.”</div></div></div>
            <div class="pv-steps">
              <div class="pv-step"><span class="n">01</span>${sysIcon('gmail', true)}<span>Inbox Triage</span><span class="st ok">${icon('check')}done</span></div>
              <div class="pv-step"><span class="n">02</span>${sysIcon('gmail', true)}<span>Reply to Lead</span><span class="st wait">approval</span></div>
              <div class="pv-step"><span class="n">03</span>${sysIcon('hubspot', true)}<span>CRM Update</span><span class="st">queued</span></div>
              <div class="pv-step"><span class="n">04</span>${sysIcon('slack', true)}<span>Daily Report</span><span class="st">queued</span></div>
            </div>
            <div class="pv-approval">${sysIcon('gmail', true)}<div class="grow small">Alex wants to click <strong>“Send”</strong> in Gmail</div><span class="btn btn-xs btn-primary">Approve</span><span class="btn btn-xs">Edit</span></div>
          </div>
        </div>
      </div>
    </section>

    <section class="l-logos" id="systems">
      <div class="l-logos-inner">
        <div><h2>Works inside the tools you already use</h2><p>Employees open your web apps in a browser tab, signed in as you. No integrations to build, no tokens to manage.</p></div>
        <div class="logo-strip">${STRIP.map((id) => `<div class="ls-item">${sysIcon(id, true)}<span>${esc(SYSTEMS[id].name)}</span></div>`).join('')}</div>
      </div>
    </section>

    <section id="how" class="l-section">
      <h2>Describe it. WorkForge <em>builds</em> the system.</h2>
      <div class="l-steps">
        ${[['01', 'Describe', 'Tell WorkForge the work in plain language — what triggers it, which apps it happens in, what needs your sign-off.', 'message-square', 'Business request'],
    ['02', 'Generate', 'The AI engine designs a custom employee: scripts, decision logic, memory and least-privilege permissions.', 'layers', 'Generated architecture'],
    ['03', 'Operate', 'The employee works in your systems through the browser extension, asking before it clicks or types.', 'play', 'Real work, approved by you']]
    .map(([n, t, d, ic, chip]) => `<div class="l-step"><div class="big">${n}</div><h3>${t}</h3><p>${d}</p><span class="chip">${icon(ic)}${chip}</span></div>`).join('')}
      </div>
    </section>

    <section id="features" class="l-section">
      <h2>Not a template. <em>Generated</em> for your business.</h2>
      <p class="l-sub">Every employee is designed from your description, your systems and your rules.</p>
      <div class="l-features">${FEATURES.map(([ic, t, d]) => `<div class="l-feature"><div class="fi">${icon(ic)}</div><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`).join('')}</div>
    </section>

    <section id="engine" class="l-section">
      <h2>One engine, running <em>everything</em>.</h2>
      <p class="l-sub">The same on-device AI engine designs employees and executes every script step — in the app and in the browser extension.</p>
      <div class="l-arch mt-24">${['Request', 'AI engine', 'Scripts', 'Your web apps · Files · Memory', 'Result', 'AI engine', 'Next script'].map((b, i, a) => `<span class="box ${b === 'AI engine' ? 'hl' : ''}">${b}</span>${i < a.length - 1 ? icon('arrow-right') : ''}`).join('')}</div>
      <div class="l-trust grid-3 mt-24">
        <div class="card card-pad"><h3>${icon('cpu')} Your GPU, your data</h3><p>An open-source model runs in your browser with WebGPU. Prompts, files and results never leave the device.</p></div>
        <div class="card card-pad"><h3>${icon('shield-check')} Human in the loop</h3><p>Sending, saving and form entries wait in the Approval Center. You can pause any employee at any time.</p></div>
        <div class="card card-pad"><h3>${icon('git-branch')} Hosted on GitHub</h3><p>No servers, no build step. Publish with GitHub Pages — it can even serve the model weights for you.</p></div>
      </div>
    </section>

    <section class="l-cta">
      <h2>Describe the employee. <em>WorkForge</em> builds the entire system.</h2>
      <a class="btn btn-primary btn-lg mt-24" href="${cta}">Build your first employee ${icon('arrow-right')}</a>
    </section>
    <footer class="l-foot"><a class="logo" href="#/"><img src="assets/img/logo.svg" alt="">WorkForge</a><span>Static app · AI runs on your device · data stays in your browser</span></footer>
  </div>`;
  el.querySelectorAll('a[href^="#"]:not([href^="#/"])').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}
