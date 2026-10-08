import { icon, esc } from '../ui.js';

const FEATURES = [
  ['layers', 'Multi-script employee architecture', 'Each employee is a set of generated scripts with inputs, outputs, tools, decision logic and failure handling.'],
  ['plug', 'Real integrations', 'Gmail, Calendar, Drive, Sheets, Slack, HubSpot, Salesforce, Shopify, Notion, Zendesk, databases and your own APIs.'],
  ['globe', 'Browser extension', 'Employees work inside the browser tab you choose — reading, navigating and filling forms within their permissions.'],
  ['activity', 'Employee activity', 'Every script, tool call, decision and approval is recorded in a complete audit log.'],
  ['shield-check', 'Security and permissions', 'Granular, per-system scopes. Outbound actions require human approval until you decide otherwise.'],
  ['file-text', 'File intelligence', 'Connect PDFs, DOCX, spreadsheets, CSV, JSON and Markdown as searchable knowledge sources.'],
  ['workflow', 'Autonomous workflows', 'The AI engine runs scripts in sequence or conditionally, passing context and choosing the next step.'],
  ['message-square', 'Natural-language control', '“Add a three-day follow-up.” The AI engine changes the actual architecture, with version history.'],
];

export default async function landing({ el, app }) {
  const started = !!app.business || (await app.db.all('employees')).length > 0;
  const cta = started ? '#/create' : '#/onboarding';
  el.innerHTML = `<div class="landing">
    <nav class="l-nav">
      <a class="logo" href="#/"><img src="assets/img/logo.svg" alt="">WorkForge</a>
      <div class="l-links">
        <a href="#how">Product</a><a href="#features">AI Employees</a><a href="#/integrations">Integrations</a><a href="#/extension">Extension</a><a href="#architecture">Architecture</a>
      </div>
      <div class="row">
        <a class="btn btn-ghost btn-sm" href="#/dashboard">Open App</a>
        <a class="btn btn-primary btn-sm" href="${cta}">Create Employee</a>
      </div>
    </nav>

    <section class="l-hero">
      <div>
        <span class="eyebrow">${icon('sparkles')} The future of work is AI employees</span>
        <h1>Build the AI Employee Your Business Actually Needs.</h1>
        <p class="lead">Describe the work. The WorkForge AI engine generates the employee — scripts, tools, memory, workflows and permissions — then runs it for you.</p>
        <div class="row mt-24 wrap">
          <a class="btn btn-primary btn-lg" href="${cta}">Create an Employee</a>
          <a class="btn btn-lg" href="#how">${icon('play')} See How It Works</a>
        </div>
        <p class="small muted mt-16">Runs entirely in your browser. Bring your own AI key — your data stays on your device.</p>
      </div>
      <div class="preview" aria-label="Illustration of the WorkForge app">
        <div class="pv-side">
          <div class="strong" style="color:var(--text)"><img src="assets/img/logo.svg" width="14" alt="">WorkForge</div>
          <div>${icon('layout-dashboard')}Overview</div><div>${icon('users')}Employees</div><div class="on">${icon('plus')}Create Employee</div>
          <div>${icon('activity')}Activity</div><div>${icon('list-checks')}Tasks</div><div>${icon('folder')}Files</div><div>${icon('server')}Systems</div>
          <div>${icon('blocks')}Integrations</div><div>${icon('puzzle')}Browser Extension</div><div>${icon('bar-chart-3')}Reports</div>
        </div>
        <div class="pv-main">
          <div class="row-top gap-16">
            <div class="card grow" style="padding:10px;font-size:11px;color:var(--text-2)">“I need an employee that monitors incoming leads, researches companies, qualifies prospects, emails them, books meetings, updates our CRM, and sends me a daily report.”</div>
            <div class="card" style="padding:10px;width:150px">
              <div class="strong">Lead Operations</div>
              <div class="tiny muted mt-4">Example architecture</div>
              <div class="grid-2 mt-8" style="gap:6px;font-size:10px"><div>Scripts<br><b>9</b></div><div>Tools<br><b>11</b></div><div>Approvals<br><b>3</b></div><div>Systems<br><b>4</b></div></div>
            </div>
          </div>
          <div class="pv-arch">
            <div class="pv-col">${['Lead Detection', 'Company Research', 'Qualification', 'CRM Update'].map((s) => `<div class="pv-item"><i></i>${s}</div>`).join('')}</div>
            <div class="pv-center">${icon('cpu')} AI Engine</div>
            <div class="pv-col">${['Lead Scoring', 'Outreach (approval)', 'Meeting Booking', 'Daily Report'].map((s) => `<div class="pv-item"><i style="background:#8b5cf6"></i>${s}</div>`).join('')}</div>
          </div>
        </div>
      </div>
    </section>

    <section id="how" class="l-section" style="padding-top:10px">
      <div class="l-steps">
        ${[['1', 'Describe', 'Tell WorkForge what you need in plain language. No technical details.', 'message-square', 'Business request'],
    ['2', 'Generate', 'The AI engine designs a custom employee: scripts, decision logic, tools, memory and permissions.', 'sparkles', 'AI generated employee'],
    ['3', 'Operate', 'Your employee works across your systems and browser tabs — with approvals where it matters.', 'zap', 'Real work, real results']]
    .map(([n, t, d, ic, chip]) => `<div class="l-step"><div class="big">${n}</div><div><h3>${t}</h3><p class="small muted mt-4">${d}</p><span class="chip mt-12">${icon(ic)}${chip}</span></div></div>`).join('')}
      </div>
    </section>

    <section id="features" class="l-section">
      <h2 style="font-size:22px">Not a template. Generated specifically for you.</h2>
      <p class="muted mt-4">Every employee is unique — built for your business, your tools, and your goals.</p>
      <div class="l-features">
        ${FEATURES.map(([ic, t, d]) => `<div class="l-feature"><div class="fi">${icon(ic)}</div><div><h4>${esc(t)}</h4><p>${esc(d)}</p></div></div>`).join('')}
      </div>
    </section>

    <section id="architecture" class="l-section">
      <h2 style="font-size:22px">How an employee runs</h2>
      <p class="muted mt-4 mb-16">The AI engine executes the generated scripts, evaluates each result, and decides what runs next.</p>
      <div class="l-arch">
        ${['Request', 'AI Engine', 'Generated Scripts', 'Tools · Files · Systems · Browser', 'Result', 'AI Evaluation', 'Next Script'].map((b, i, a) => `<span class="box">${b}</span>${i < a.length - 1 ? icon('arrow-right') : ''}`).join('')}
      </div>
      <div class="grid-3 mt-24">
        <div class="card card-pad"><h3>${icon('lock')} Your keys, your browser</h3><p class="small muted mt-8">WorkForge is a static app. API keys are kept in an optional passphrase-encrypted vault in your browser and sent only to the provider you choose.</p></div>
        <div class="card card-pad"><h3>${icon('shield-check')} Human in the loop</h3><p class="small muted mt-8">Emails, CRM writes, bookings and browser clicks wait in the Approval Center until you approve, edit or reject them.</p></div>
        <div class="card card-pad"><h3>${icon('git-branch')} Hosted on GitHub</h3><p class="small muted mt-8">No servers, no build step. Publish with GitHub Pages; load the extension from the same repository.</p></div>
      </div>
    </section>

    <section class="l-section" style="text-align:center">
      <h2 style="font-size:28px">Describe the employee. WorkForge builds the entire system.</h2>
      <a class="btn btn-primary btn-lg mt-24" href="${cta}">Build Your First AI Employee ${icon('arrow-right')}</a>
    </section>
    <footer class="l-foot"><span>© ${new Date().getFullYear()} WorkForge</span><span>Static app · data stored locally in your browser</span></footer>
  </div>`;
  el.querySelectorAll('a[href^="#"]:not([href^="#/"])').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}
