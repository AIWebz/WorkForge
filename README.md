# WorkForge

**Describe the employee. WorkForge builds the entire system.**

WorkForge turns a plain-language description of a job into an AI employee and runs it. Each employee is a set of generated scripts, decision logic, memory and permissions. It works inside the web apps you already use (Gmail, HubSpot, Zendesk, Salesforce, Notion…) through the WorkForge browser extension, signed in as you.

- **No APIs, no AI provider, no keys.** The AI engine is an open-source language model that runs on your own computer's GPU, inside the browser (WebGPU via the bundled WebLLM). It designs every employee and executes every script step.
- **No server, no build step.** A static site plus a Chrome extension, hosted entirely on GitHub Pages. Pages can also serve the model weights.
- **No credentials stored.** Connecting a system only records its address. Employees use your own signed-in browser session, and every click and form entry waits for your approval by default.

---

## Run it

**GitHub Pages**
1. Push this repository to GitHub.
2. In **Settings → Pages**, choose **Source: GitHub Actions**. `.github/workflows/pages.yml` deploys on every push to `main`. (Deploy from a branch also works; `.nojekyll` is included.)
3. Open `https://<user>.github.io/<repo>/`.

**Locally:** run `python3 -m http.server` in the repo and open `http://localhost:8000`.

**Requirements:** a WebGPU browser (recent Chrome, Edge or Brave) on a computer with a GPU. There is nothing to set up: WorkForge picks the best model your GPU can hold (Qwen 2.5 3B, or 1.5B on smaller GPUs), downloads it once in the background, and falls back to the smaller model if loading fails. On GPUs without 16-bit shader support it uses the 32-bit build.

### Self-host the model (optional)
By default the model weights download once from the public open-model mirror (Hugging Face) and are cached by the browser. To serve them from your own GitHub Pages site instead:

1. Go to **Settings → Secrets and variables → Actions → Variables** and add `WORKFORGE_MODEL`, for example `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`. Several ids can be comma-separated.
2. Re-run the Pages workflow. `.github/scripts/fetch-model.mjs` downloads the weights into `models/` during the deploy and lists them in `models/manifest.json`.
3. Nothing to change in the app. When `models/manifest.json` lists models, WorkForge loads them from your site automatically.

GitHub Pages sites are limited to about 1 GB, so pick a small model to self-host.

## First steps
1. **Onboarding:** describe what your business does and what to automate, then pick your systems. You're never asked for a company name.
2. **AI engine:** nothing to do. It starts by itself in the background (progress shows in the sidebar). The first start downloads the model once.
3. **Systems:** connect the web apps employees work in. Apps like Salesforce, Zendesk, Jira and monday.com ask for your address; nothing else is stored.
4. **Browser Extension:** install it and click **Connect extension**.
5. **Create Employee:** describe the work, generate, review and deploy. Then run a task from the profile, a schedule, or the extension side panel.

---

## How it works

```
Request → AI engine (analysis) → AI engine (architecture, schema-constrained) → validate → Employee
Task → Script → AI engine turn → tool call → permission check → (approval?) → execute in the browser tab
     → result → AI engine evaluation → next script → … → END
```

| Area | Implementation |
| --- | --- |
| AI engine | `extension/core/engine.js` + `ai.js`. WebLLM runs in a web worker. Each turn the model must return `{thought, tool, args}`, and grammar-guided decoding enforces a JSON schema built from the offered tools, so even small models produce valid tool calls. |
| Generation | `extension/core/generator.js`. A requirements-analysis step, then an architecture step whose output is constrained to the employee schema. Local steps then compile the decision logic, memory, least-privilege permissions and validation checks. |
| Script runtime | `extension/core/runtime.js`. Runs one script at a time with only that script's tools, applies retry / escalate / skip / stop failure strategies, persists state after each step, and never silently repeats a side effect after a reload. |
| Systems | `extension/core/catalog.js`. A catalog of 28 web apps with real logos (`assets/img/systems/`, CC0 — see `LICENSE.md` there) plus custom web apps. |
| Browser tools | `browser_open`, `read_page`, `extract`, `scroll`, `wait`, `navigate`, `click` and `fill`, executed by the extension in the working tab (`extension/browser-tools.js`). Password fields are off-limits. |
| Permissions | Per system: read / navigate / click / type, each set to allow, approval or deny. Click and type start as approval-required. Navigation is limited to the employee's systems plus read-only "other websites". |
| Approvals | Approval Center and the extension side panel: approve, edit the arguments, reject with a note, or pause the employee. Escalations take a written answer. |
| Memory & files | Per-employee memory with BM25 retrieval. PDF, DOCX, XLSX, CSV, Markdown, JSON and HTML are parsed in the browser. |
| Natural-language control | Chat and the workflow editor turn instructions into versioned architecture changes with undo. |
| Reports | Computed from real task, script, approval and metric records. The AI writes summaries only from that data. |

### Browser extension (`extension/`)
A Manifest V3 extension (Chromium 116+) that imports the same `extension/core` modules as the app and runs its own copy of the on-device AI engine.

- **Install:** use **Download extension (.zip)** on the Browser Extension page (or this repo's `extension/` folder). Then open `chrome://extensions`, turn on Developer mode and click **Load unpacked**.
- **Connect:** click *Connect extension* in the app and approve the pairing window. Only paired app origins are served.
- **Work:** open the side panel, choose an employee, then choose an open tab or "Open Gmail in a new tab", and click **Start Working**. Chrome asks for access to those sites only. Approvals appear inline, and results sync back to the app's Activity.

## Limitations (static hosting)
- **Browser must stay open.** Schedules and follow-ups run while WorkForge is open in a tab; tasks started from the extension run while its side panel is open.
- **No inbound webhooks.** Without a server, other apps can't push events in. Use schedules that check your inbox or CRM instead.
- **Model quality depends on your GPU.** Small local models handle well-defined, step-by-step work best. WorkForge uses the largest model your GPU can hold.
- **The extension has its own model copy.** It caches the model separately from the app, so it downloads once more there.

## Layout
```
index.html               SPA entry (hash router)
app/                     UI shell, pages, extension bridge, file parsing, engine worker
assets/css/app.css       Design system
assets/img/              Logo and system logos
assets/vendor/           Bundled libraries (WebLLM, lucide, pdf.js, mammoth, SheetJS, JSZip) + licenses
extension/               Chrome extension (Load unpacked); extension/core = shared engine
.github/                 Pages deploy + optional model self-hosting
```
