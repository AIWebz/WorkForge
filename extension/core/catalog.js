// Catalog of the systems (web apps) an employee can work in and every tool the
// AI engine can call. There are no third-party API integrations: scripts are
// executed by the AI engine, and employees act inside systems through the
// WorkForge browser extension using the user's own signed-in browser session.

const S = (props) => ({ type: 'object', properties: props, required: Object.keys(props).filter((k) => !props[k].optional) });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const opt = (schema) => ({ ...schema, optional: true });
const clean = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k === 'optional' ? undefined : v)));
const props = (o) => clean(S(o));

// Scopes every system supports. read covers reading/extracting/scrolling.
export const SYSTEM_SCOPES = ['read', 'navigate', 'click', 'form_input'];
export const SCOPE_LABELS = { read: 'Read', navigate: 'Navigate', click: 'Click', form_input: 'Type & submit' };
// Scopes that change things in a system. They start as approval-required.
export const SENSITIVE_SCOPES = new Set(['click', 'form_input']);
export const DEFAULT_SCOPE_LEVELS = { read: 'allow', navigate: 'allow', click: 'approval', form_input: 'approval' };

/**
 * Web apps employees can work in.
 * - url:      where the employee opens the app
 * - match:    host patterns (optionally with a path prefix) that identify the app;
 *             "*.example.com" matches any subdomain
 * - address:  if set, the user must enter their own address (org/store/site URL)
 */
export const SYSTEMS = {
  gmail: { name: 'Gmail', group: 'Google Workspace', url: 'https://mail.google.com/', match: ['mail.google.com'], description: 'Read, triage, draft and send email.' },
  google_calendar: { name: 'Google Calendar', group: 'Google Workspace', url: 'https://calendar.google.com/', match: ['calendar.google.com'], description: 'Check availability and schedule meetings.' },
  google_drive: { name: 'Google Drive', group: 'Google Workspace', url: 'https://drive.google.com/', match: ['drive.google.com'], description: 'Find and open files and folders.' },
  google_sheets: { name: 'Google Sheets', group: 'Google Workspace', url: 'https://docs.google.com/spreadsheets/', match: ['docs.google.com/spreadsheets'], description: 'Read and update spreadsheets.' },
  google_docs: { name: 'Google Docs', group: 'Google Workspace', url: 'https://docs.google.com/document/', match: ['docs.google.com/document'], description: 'Read and write documents.' },
  outlook: { name: 'Outlook', group: 'Microsoft 365', url: 'https://outlook.office.com/mail/', match: ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'], description: 'Email and calendar in Microsoft 365.' },
  microsoft_teams: { name: 'Microsoft Teams', group: 'Microsoft 365', url: 'https://teams.microsoft.com/', match: ['teams.microsoft.com', 'teams.live.com'], description: 'Chats, channels and meetings.' },
  slack: { name: 'Slack', group: 'Communication', url: 'https://app.slack.com/client', match: ['app.slack.com', '*.slack.com'], description: 'Read channels and post messages.' },
  linkedin: { name: 'LinkedIn', group: 'Sales & CRM', url: 'https://www.linkedin.com/', match: ['www.linkedin.com', 'linkedin.com'], description: 'Research people and companies.' },
  salesforce: { name: 'Salesforce', group: 'Sales & CRM', url: '', match: ['*.lightning.force.com', '*.my.salesforce.com', '*.salesforce.com'], address: { label: 'Your Salesforce URL', placeholder: 'https://yourorg.lightning.force.com' }, description: 'Leads, contacts, opportunities and records.' },
  hubspot: { name: 'HubSpot', group: 'Sales & CRM', url: 'https://app.hubspot.com/', match: ['app.hubspot.com', 'app-eu1.hubspot.com'], description: 'Contacts, companies, deals and notes.' },
  zendesk: { name: 'Zendesk', group: 'Support', url: '', match: ['*.zendesk.com'], address: { label: 'Your Zendesk URL', placeholder: 'https://yourcompany.zendesk.com/agent' }, description: 'Tickets, macros and customer replies.' },
  intercom: { name: 'Intercom', group: 'Support', url: 'https://app.intercom.com/', match: ['app.intercom.com', 'app.eu.intercom.com'], description: 'Conversations and help center.' },
  shopify: { name: 'Shopify', group: 'Commerce & Finance', url: 'https://admin.shopify.com/', match: ['admin.shopify.com', '*.myshopify.com'], description: 'Orders, products and customers.' },
  stripe: { name: 'Stripe', group: 'Commerce & Finance', url: 'https://dashboard.stripe.com/', match: ['dashboard.stripe.com'], description: 'Payments, customers and invoices.' },
  quickbooks: { name: 'QuickBooks', group: 'Commerce & Finance', url: 'https://qbo.intuit.com/', match: ['qbo.intuit.com', 'app.qbo.intuit.com'], description: 'Invoices, bills and accounting.' },
  notion: { name: 'Notion', group: 'Productivity', url: 'https://www.notion.so/', match: ['www.notion.so', 'notion.so'], description: 'Pages, wikis and databases.' },
  airtable: { name: 'Airtable', group: 'Productivity', url: 'https://airtable.com/', match: ['airtable.com'], description: 'Bases, tables and records.' },
  trello: { name: 'Trello', group: 'Productivity', url: 'https://trello.com/', match: ['trello.com'], description: 'Boards, lists and cards.' },
  asana: { name: 'Asana', group: 'Productivity', url: 'https://app.asana.com/', match: ['app.asana.com'], description: 'Projects and tasks.' },
  monday: { name: 'monday.com', group: 'Productivity', url: '', match: ['*.monday.com'], address: { label: 'Your monday.com URL', placeholder: 'https://yourteam.monday.com' }, description: 'Boards and items.' },
  clickup: { name: 'ClickUp', group: 'Productivity', url: 'https://app.clickup.com/', match: ['app.clickup.com'], description: 'Tasks and docs.' },
  jira: { name: 'Jira', group: 'Engineering', url: '', match: ['*.atlassian.net'], address: { label: 'Your Jira site', placeholder: 'https://yourteam.atlassian.net' }, description: 'Issues, boards and sprints.' },
  linear: { name: 'Linear', group: 'Engineering', url: 'https://linear.app/', match: ['linear.app'], description: 'Issues and projects.' },
  github: { name: 'GitHub', group: 'Engineering', url: 'https://github.com/', match: ['github.com'], description: 'Repositories, issues and pull requests.' },
  mailchimp: { name: 'Mailchimp', group: 'Marketing', url: 'https://login.mailchimp.com/', match: ['*.admin.mailchimp.com', 'login.mailchimp.com', 'mailchimp.com'], description: 'Audiences and campaigns.' },
  google_analytics: { name: 'Google Analytics', group: 'Marketing', url: 'https://analytics.google.com/', match: ['analytics.google.com'], description: 'Traffic and conversion reports.' },
  wordpress: { name: 'WordPress', group: 'Marketing', url: '', match: [], address: { label: 'Your WordPress admin URL', placeholder: 'https://yoursite.com/wp-admin' }, description: 'Posts, pages and site content.' },
};

export const SYSTEM_GROUPS = ['Google Workspace', 'Microsoft 365', 'Communication', 'Sales & CRM', 'Support', 'Commerce & Finance', 'Productivity', 'Engineering', 'Marketing'];

// Logo path relative to the web app root (index.html). Custom systems have no logo.
export function systemIcon(id) {
  return SYSTEMS[id] ? `assets/img/systems/${id}.svg` : '';
}

/**
 * All systems including user-added custom web apps.
 * @param {Array<{id:string, custom?:boolean, name?:string, url?:string}>} connections rows from the `connections` store
 */
export function allSystems(connections = []) {
  const out = { ...SYSTEMS };
  for (const c of connections) {
    if (c.custom && c.id && c.url) out[c.id] = { name: c.name || hostOf(c.url), group: 'Custom', url: c.url, match: [hostOf(c.url)], custom: true, description: c.description || 'Custom web app.' };
  }
  return out;
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function patternMatches(pattern, u) {
  const [hostPat, ...pathParts] = pattern.split('/');
  const path = pathParts.length ? `/${pathParts.join('/')}` : '';
  const host = u.hostname.toLowerCase();
  const hostOk = hostPat.startsWith('*.') ? host === hostPat.slice(2) || host.endsWith(hostPat.slice(1)) : host === hostPat;
  return hostOk && (!path || u.pathname.startsWith(path));
}

/** The match patterns for a system, including the address the user connected. */
export function systemPatterns(id, connections = []) {
  const sys = allSystems(connections)[id];
  if (!sys) return [];
  const conn = connections.find((c) => c.id === id);
  const pats = [...(sys.match || [])];
  if (conn?.url) { const h = hostOf(conn.url); if (h && !pats.includes(h)) pats.push(h); }
  return pats;
}

/** Which system a URL belongs to (most specific pattern wins), or null for other websites. */
export function systemForUrl(url, connections = []) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let best = null;
  let bestLen = -1;
  for (const id of Object.keys(allSystems(connections))) {
    for (const p of systemPatterns(id, connections)) {
      if (patternMatches(p, u) && p.length > bestLen) { best = id; bestLen = p.length; }
    }
  }
  return best;
}

/** Where an employee opens a system: the user's connected address, else the app's default URL. */
export function systemUrl(id, connections = []) {
  const conn = connections.find((c) => c.id === id);
  return conn?.url || allSystems(connections)[id]?.url || '';
}

/** Host permission origins ("https://host/*") the extension needs for a system. */
export function systemOrigins(id, connections = []) {
  const set = new Set();
  for (const p of systemPatterns(id, connections)) {
    const host = p.split('/')[0];
    set.add(`https://${host}/*`);
  }
  return [...set];
}

// ----------------------------------------------------------------- Tools
// `system` is 'internal', 'files' or 'browser'. Browser tools resolve the target
// system from the URL they act on; `scope` is the scope checked on that system.
export const TOOLS = [
  // Internal tools: always scoped to the employee's own data (employee isolation).
  { name: 'memory_search', system: 'internal', scope: 'read',
    description: "Search this employee's memory (instructions, business info, long-term notes, previous results) and granted knowledge files.",
    input_schema: props({ query: str('What to look for') }) },
  { name: 'memory_save', system: 'internal', scope: 'write',
    description: 'Save a durable fact to long-term memory so future tasks can use it.',
    input_schema: props({ content: str('The fact or note to remember'), kind: opt(str('long_term | business | task', { enum: ['long_term', 'business', 'task'] })) }) },
  { name: 'record_metric', system: 'internal', scope: 'write',
    description: 'Increment a business metric for reporting, e.g. leads_processed, meetings_booked, tickets_resolved.',
    input_schema: props({ metric: str('snake_case metric key'), value: opt({ type: 'number', description: 'Amount to add (default 1)' }) }) },
  { name: 'request_human_help', system: 'internal', scope: 'write',
    description: 'Escalate to a human. Pauses the task until a person responds. Use for ambiguity, risk, policy questions, missing logins or failures you cannot resolve.',
    input_schema: props({ question: str('What you need the human to decide or provide'), context: opt(str('Relevant details')) }),
    summarize: (a) => `needs help: ${a.question}` },
  { name: 'schedule_followup', system: 'internal', scope: 'write',
    description: 'Schedule a future task for this employee (e.g. a follow-up in 3 days). Runs while WorkForge is open in a browser.',
    input_schema: props({ delay_minutes: { type: 'number', description: 'Minutes from now' }, instruction: str('What the employee should do then'), entry_script: opt(str('Script id to start from')) }),
    summarize: (a) => `schedule a follow-up in ${a.delay_minutes} min: ${a.instruction}` },
  { name: 'notify_user', system: 'internal', scope: 'write',
    description: 'Send an in-app notification / report to the business owner.',
    input_schema: props({ title: str('Short title'), message: str('Notification body (markdown allowed)') }) },

  // Knowledge files (parsed and stored locally in the browser)
  { name: 'files_search', system: 'files', scope: 'read',
    description: 'Full-text search across the knowledge files this employee may read.',
    input_schema: props({ query: str('Search query') }) },
  { name: 'files_read', system: 'files', scope: 'read',
    description: 'Read the text of a granted knowledge file by id (from files_search results).',
    input_schema: props({ file_id: str('File id') }) },

  // Browser: the employee works inside systems through the WorkForge extension.
  { name: 'browser_open', system: 'browser', scope: 'navigate',
    description: 'Open one of your connected systems in a working browser tab (reuses the task tab if there is one). Use the system id, optionally with a path or full URL inside that system.',
    input_schema: props({ system: str('System id, e.g. gmail, hubspot'), url: opt(str('Optional full URL inside the system')) }),
    summarize: (a) => `open ${a.system}${a.url ? ` at ${a.url}` : ''}` },
  { name: 'browser_read_page', system: 'browser', scope: 'read',
    description: 'Read the working tab: URL, title, visible text and interactive elements with ref ids.',
    input_schema: props({}) },
  { name: 'browser_extract', system: 'browser', scope: 'read',
    description: 'Extract text from elements matching a CSS selector in the working tab.',
    input_schema: props({ selector: str('CSS selector'), limit: opt({ type: 'number' }) }) },
  { name: 'browser_scroll', system: 'browser', scope: 'read',
    description: 'Scroll the working tab up or down one screen.',
    input_schema: props({ direction: str('up | down', { enum: ['up', 'down'] }) }) },
  { name: 'browser_wait', system: 'browser', scope: 'read',
    description: 'Wait for the page to finish loading or updating (1–10 seconds).',
    input_schema: props({ seconds: { type: 'number', description: 'Seconds to wait' } }) },
  { name: 'browser_navigate', system: 'browser', scope: 'navigate',
    description: 'Navigate the working tab to a URL inside a system this employee may use.',
    input_schema: props({ url: str('URL') }),
    summarize: (a) => `navigate to ${a.url}` },
  { name: 'browser_click', system: 'browser', scope: 'click',
    description: 'Click an element by ref id from browser_read_page.',
    input_schema: props({ ref: str('Element ref id'), description: opt(str('What this click does, e.g. "Send email"')) }),
    summarize: (a) => `click ${a.description ? `“${a.description}”` : `element ${a.ref}`}` },
  { name: 'browser_fill', system: 'browser', scope: 'form_input',
    description: 'Type a value into an input, textarea, select or editable field by ref id.',
    input_schema: props({ ref: str('Element ref id'), value: str('Value to enter'), field: opt(str('Field label')) }),
    summarize: (a) => `enter “${String(a.value).slice(0, 60)}” into ${a.field || `field ${a.ref}`}` },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const BROWSER_TOOLS = TOOLS.filter((t) => t.system === 'browser').map((t) => t.name);
export const INTERNAL_TOOLS = TOOLS.filter((t) => t.system === 'internal').map((t) => t.name);

export const COMPLETE_TOOL = {
  name: 'complete_script',
  description: 'Finish the current script. Call exactly once when the script is done, failed, or needs a human. Provide the structured output and choose the next script.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['success', 'failed', 'needs_human'] },
      summary: { type: 'string', description: 'One or two sentences describing what happened' },
      output: { type: 'object', description: "Structured output matching the script's declared outputs" },
      next_script: { type: 'string', description: 'Id of the next script to run, or END' },
      reason: { type: 'string', description: 'Why this next step was chosen' },
    },
    required: ['status', 'summary', 'output', 'next_script'],
  },
};

export function describeAction(tool, args = {}, systemName = '') {
  let text = `use ${tool.name.replace(/_/g, ' ')}`;
  if (tool.summarize) {
    try { text = tool.summarize(args); } catch { /* keep default */ }
  }
  return systemName && tool.system === 'browser' && tool.name !== 'browser_open' ? `${text} in ${systemName}` : text;
}

// Compact catalog text for prompts.
export function catalogForPrompt(connections = []) {
  const sys = allSystems(connections);
  return [
    'Systems (web apps the employee operates through the browser, with the owner\'s own login):',
    ...Object.entries(sys).map(([id, s]) => `- ${id}: ${s.name} — ${s.description}`),
    '',
    'Tools:',
    ...TOOLS.filter((t) => t.system !== 'internal').map((t) => `- ${t.name} [${t.system}:${t.scope}] ${t.description}`),
  ].join('\n');
}
