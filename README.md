# WorkForge

**Describe the employee. WorkForge builds the entire system.**

WorkForge is a static web app plus a browser extension. You describe the AI employee your business needs. The AI engine then generates that employee's architecture (scripts, decision logic, tools, memory, permissions and triggers) and runs it against your real systems and browser tabs. Human approval gates and a full audit log cover every action.

It runs entirely from a GitHub repository. There is no server, no build step, no Node/npm/Python, and no third-party hosting.

---

## Run it

**GitHub Pages (recommended)**
1. Push this repository to GitHub.
2. Go to **Settings → Pages** and pick one of these:
   - **Source: GitHub Actions**. The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
   - **Source: Deploy from a branch** (`main` / root). This works too; `.nojekyll` is included.
3. Open `https://<user>.github.io/<repo>/`.

**Locally:** serve the folder with any static file server, e.g. `python3 -m http.server`, then open `http://localhost:8000`. ES modules don't load from `file://`.

## First steps

1. **Settings → AI Engine.** Choose a provider and paste your API key. Claude (Anthropic) is the default; OpenAI or any OpenAI-compatible endpoint also works (OpenRouter, Groq, or a local Ollama with `OLLAMA_ORIGINS` set). Click **Test connection**.
2. **Create Employee.** Describe the work and click **Generate Employee**. Review the result and click **Deploy**.
3. **Integrations.** Connect the systems the employee uses.
4. **Files.** Upload knowledge, then grant collections on the employee's Files tab.
5. **Run task** from the employee's profile, enable a schedule, or start it in a browser tab with the extension.

---

## How it works

```
Request → AI engine (analysis) → AI engine (architecture) → normalize + validate → Employee
Task → Script → AI engine turn → tool calls → permission check → (approval?) → execute
     → structured result → AI engine evaluation (choose next script) → … → END
```

| Area | Implementation |
| --- | --- |
| AI engine | `extension/core/ai.js`: direct browser calls to the provider with your key. Claude uses the `anthropic-dangerous-direct-browser-access` header and server-side refusal fallbacks on supported models. |
| Generation | `extension/core/generator.js`: two real model calls (requirement analysis, architecture design), then local compile steps: decision logic, memory seeding, least-privilege permissions, tool binding, and a validation suite. The progress screen reflects these real stages. |
| Script runtime | `extension/core/runtime.js`: runs one script at a time with only that script's permitted tools. Each script ends with a structured `complete_script` call; the engine validates the chosen transition against the workflow graph and applies failure strategies (retry / escalate / skip / stop). State is persisted after every step, so tasks survive reloads, and side-effecting calls are never silently repeated. |
| Tools | `extension/core/tools.js` + `catalog.js`: real HTTP calls to Gmail, Calendar, Drive, Sheets, Slack, HubSpot, Salesforce, Shopify, Notion, Zendesk, PostgREST databases, custom REST APIs, webhooks, web fetch, files, memory and browser actions. |
| Permissions | Per system and scope, set to `allow`, `approval` or `deny`, and checked on every call. Outbound scopes (send / write / create / click / form input / navigate) start as approval-required. There's an optional workspace-wide "approve all outbound" switch. |
| Approvals | Approval Center: approve, edit the arguments, reject with a note, or pause the employee. Escalations (`request_human_help`) take a written answer. |
| Memory | Per-employee instructions, business, long-term, task, conversation, system and execution memory, plus granted file knowledge. Retrieval is BM25 (`extension/core/memory.js`). |
| Files | PDF, DOCX, XLSX/XLS, CSV, TXT, Markdown, JSON and HTML are parsed in the browser. Images can be transcribed by the AI engine on request. |
| Natural-language control | Employee **Chat** and the workflow editor send your instruction to the AI engine, which returns structured operations (`extension/core/modifier.js`). They're applied to the stored architecture, each change is versioned, and **Undo** restores the previous version. |
| Reports | Computed from task, script, approval and metric records. The AI writes summaries only from that data. |
| Storage | IndexedDB in your browser; changes sync live across tabs. **Settings → Data** exports and imports backups (credentials are never included). |

### Browser extension (`extension/`)

A Manifest V3 extension (Chromium 116+) that runs the **same `extension/core` modules** as the app; the web app imports them from that folder.

- **Install:** use the **Browser Extension** page's *Download extension (.zip)* button, or this repo's `extension/` folder. Then open `chrome://extensions`, turn on Developer mode, and click **Load unpacked**.
- **Connect:** on the Browser Extension page, click *Connect extension* and approve the pairing window. Only origins you pair are served.
- **Work in a tab:** open the side panel, then choose an employee, choose a tab, and click **Start Working**. Chrome asks for access to that one site. Approvals appear inline in the panel, and results sync back to the app's Activity.
- **Relay:** HubSpot, Notion, Shopify and Zendesk block browser requests (CORS), so the paired extension relays those API calls.
- **Safety:** the extension never reads or types into password fields, limits navigation to the working site plus domains you allow, and checks each action against the employee's browser scopes.
- **Custom domain:** the bridge activates automatically on `*.github.io` and `localhost`. For other domains, add your app's address in the side panel under ⚙ Settings.

---

## Security model

- **No secrets in the repository.** API keys and tokens live in a local credential vault: session-only (default), AES-GCM encrypted with a passphrase, or device storage.
- Credentials are sent only to the provider or system they belong to. A strict Content-Security-Policy allows scripts only from this site and Google Identity Services.
- **Employee isolation:** each employee reads only its own memory and the collections you grant.
- Model-facing prompts treat tool output (emails, web pages, documents) as untrusted data, not instructions.
- Every task, script, tool call (with input and output), decision, error and approval is written to the audit log.

## Honest limitations of static hosting

- **No always-on server.** Schedules and follow-ups run while WorkForge is open in a browser tab (one tab is elected leader). Browser-tab tasks run while the side panel is open.
- **Inbound webhooks** (services pushing events to WorkForge) are impossible without a server. Use schedules that poll instead, e.g. "check Gmail every 15 minutes".
- **Google access tokens** from browser OAuth last about an hour; reconnect when they expire. You need your own OAuth Client ID, with your Pages URL as an authorized JavaScript origin.
- **Your AI provider bills your account.** Use a key with spend limits.

## Repository layout

```
index.html               SPA entry (hash router)
app/                     UI: shell, pages, vault, bridge, file parsing, Google OAuth
assets/css/app.css       Design system
assets/vendor/           Vendored libraries (lucide, pdf.js, mammoth, SheetJS, JSZip) + licenses
extension/               Chrome extension (Load unpacked)
extension/core/          Shared engine: AI, catalog, employee model, generator, runtime, tools, memory, modifier, reports, DB
.github/workflows/       GitHub Pages deployment
```

If you add files to `extension/`, the Pages workflow regenerates `extension/files.json`, which the in-browser ZIP builder uses. If you deploy from a branch instead, update `files.json` by hand.
