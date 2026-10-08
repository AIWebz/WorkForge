// Catalog of systems an employee can be connected to, their permission scopes,
// and every tool the AI engine can call. Tool executors live in tools.js.

const S = (props) => ({ type: 'object', properties: props, required: Object.keys(props).filter((k) => !props[k].optional) });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const opt = (schema) => ({ ...schema, optional: true });
const clean = (schema) => JSON.parse(JSON.stringify(schema, (k, v) => (k === 'optional' ? undefined : v)));

// Scopes that never execute without explicit human approval unless the user
// changes the permission to "allow".
export const SENSITIVE_SCOPES = new Set(['send', 'write', 'create', 'click', 'form_input', 'navigate']);

export const SCOPE_LABELS = {
  read: 'Read', write: 'Write', send: 'Send', create: 'Create', navigate: 'Navigate', click: 'Click', form_input: 'Form input', extract: 'Extract',
};

export const SYSTEMS = {
  gmail: {
    name: 'Gmail', group: 'Google Workspace', connection: 'google', color: '#EA4335', glyph: 'M',
    scopes: ['read', 'send'], description: 'Search, read and send email from the connected Google account.',
    googleScopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  },
  google_calendar: {
    name: 'Google Calendar', group: 'Google Workspace', connection: 'google', color: '#4285F4', glyph: 'C',
    scopes: ['read', 'create'], description: 'Check availability and create calendar events / meetings.',
    googleScopes: ['https://www.googleapis.com/auth/calendar.events'],
  },
  google_drive: {
    name: 'Google Drive', group: 'Google Workspace', connection: 'google', color: '#0F9D58', glyph: 'D',
    scopes: ['read'], description: 'Search and read Docs, Sheets and files in Drive.',
    googleScopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  google_sheets: {
    name: 'Google Sheets', group: 'Google Workspace', connection: 'google', color: '#34A853', glyph: 'S',
    scopes: ['read', 'write'], description: 'Read ranges and append rows to spreadsheets.',
    googleScopes: ['https://www.googleapis.com/auth/spreadsheets'],
  },
  slack: {
    name: 'Slack', group: 'Communication', connection: 'slack', color: '#4A154B', glyph: '#',
    scopes: ['read', 'send'], description: 'Post messages and read channel history with a bot token.',
  },
  hubspot: {
    name: 'HubSpot', group: 'CRM', connection: 'hubspot', color: '#FF7A59', glyph: 'H',
    scopes: ['read', 'write'], description: 'Search, create and update CRM contacts, companies and deals.',
  },
  salesforce: {
    name: 'Salesforce', group: 'CRM', connection: 'salesforce', color: '#00A1E0', glyph: 'SF',
    scopes: ['read', 'write'], description: 'Run SOQL queries and create / update records.',
  },
  shopify: {
    name: 'Shopify', group: 'Commerce', connection: 'shopify', color: '#95BF47', glyph: 'S',
    scopes: ['read', 'write'], description: 'Read orders, products and customers; update records.',
  },
  notion: {
    name: 'Notion', group: 'Knowledge', connection: 'notion', color: '#111111', glyph: 'N',
    scopes: ['read', 'write'], description: 'Search pages and create new pages in your workspace.',
  },
  zendesk: {
    name: 'Zendesk', group: 'Support', connection: 'zendesk', color: '#03363D', glyph: 'Z',
    scopes: ['read', 'write'], description: 'Search, create and update support tickets.',
  },
  database: {
    name: 'Database (REST)', group: 'Data', connection: 'database', color: '#336791', glyph: 'DB',
    scopes: ['read', 'write'], description: 'Query and insert rows through a PostgREST-compatible HTTP API.',
  },
  api: {
    name: 'Custom REST API', group: 'Data', connection: 'api', color: '#6366F1', glyph: '{}',
    scopes: ['read', 'write'], description: 'Call your own HTTP API (GET = read, other methods = write).',
  },
  webhook: {
    name: 'Outgoing Webhook', group: 'Data', connection: 'webhook', color: '#0EA5E9', glyph: '↗',
    scopes: ['send'], description: 'POST JSON payloads to Zapier, Make, n8n or your own endpoint.',
  },
  web: {
    name: 'Web Research', group: 'Browser', connection: null, color: '#0891B2', glyph: 'W',
    scopes: ['read'], description: 'Fetch public web pages (requires the WorkForce extension relay for most sites).',
  },
  browser: {
    name: 'Browser', group: 'Browser', connection: null, color: '#7C3AED', glyph: 'B',
    scopes: ['read', 'navigate', 'click', 'form_input', 'extract'], description: 'Work inside a browser tab through the WorkForce extension.',
  },
  files: {
    name: 'Files & Knowledge', group: 'Knowledge', connection: null, color: '#F59E0B', glyph: 'F',
    scopes: ['read'], description: 'Search and read the knowledge collections granted to the employee.',
  },
};

// Connection definitions (credentials are stored in the vault, config in IndexedDB).
export const CONNECTIONS = {
  google: {
    name: 'Google Workspace', systems: ['gmail', 'google_calendar', 'google_drive', 'google_sheets'], color: '#4285F4', glyph: 'G',
    auth: 'google-oauth',
    fields: [{ key: 'clientId', label: 'OAuth Client ID', placeholder: '1234-abc.apps.googleusercontent.com', help: 'Create a Web OAuth client in Google Cloud Console and add this site as an Authorized JavaScript origin.' }],
    transport: 'direct',
  },
  slack: {
    name: 'Slack', systems: ['slack'], color: '#4A154B', glyph: '#',
    fields: [{ key: 'token', label: 'Bot User OAuth Token', placeholder: 'xoxb-…', secret: true, help: 'From api.slack.com/apps → OAuth & Permissions. Scopes: chat:write, channels:history.' }],
    transport: 'direct-or-relay', hosts: ['https://slack.com/*'],
  },
  hubspot: {
    name: 'HubSpot', systems: ['hubspot'], color: '#FF7A59', glyph: 'H',
    fields: [{ key: 'token', label: 'Private App Access Token', placeholder: 'pat-…', secret: true, help: 'HubSpot → Settings → Integrations → Private Apps. HubSpot blocks browser requests, so calls are relayed through the WorkForce extension.' }],
    transport: 'relay', hosts: ['https://api.hubapi.com/*'],
  },
  salesforce: {
    name: 'Salesforce', systems: ['salesforce'], color: '#00A1E0', glyph: 'SF',
    fields: [
      { key: 'instanceUrl', label: 'Instance URL', placeholder: 'https://yourorg.my.salesforce.com' },
      { key: 'accessToken', label: 'Access Token', placeholder: '00D…', secret: true, help: 'Add this site to Setup → CORS allowed origins for direct calls, or use the extension relay.' },
    ],
    transport: 'direct-or-relay', hosts: ['https://*.salesforce.com/*', 'https://*.my.salesforce.com/*'],
  },
  shopify: {
    name: 'Shopify', systems: ['shopify'], color: '#95BF47', glyph: 'S',
    fields: [
      { key: 'shop', label: 'Shop domain', placeholder: 'your-store.myshopify.com' },
      { key: 'token', label: 'Admin API access token', placeholder: 'shpat_…', secret: true, help: 'Shopify blocks browser requests to the Admin API, so calls are relayed through the WorkForce extension.' },
    ],
    transport: 'relay', hosts: ['https://*.myshopify.com/*'],
  },
  notion: {
    name: 'Notion', systems: ['notion'], color: '#111111', glyph: 'N',
    fields: [{ key: 'token', label: 'Internal Integration Secret', placeholder: 'ntn_… / secret_…', secret: true, help: 'Share the pages the employee needs with your integration. Relayed through the extension.' }],
    transport: 'relay', hosts: ['https://api.notion.com/*'],
  },
  zendesk: {
    name: 'Zendesk', systems: ['zendesk'], color: '#03363D', glyph: 'Z',
    fields: [
      { key: 'subdomain', label: 'Subdomain', placeholder: 'yourcompany' },
      { key: 'email', label: 'Agent email', placeholder: 'agent@company.com' },
      { key: 'apiToken', label: 'API token', placeholder: '••••', secret: true },
    ],
    transport: 'relay', hosts: ['https://*.zendesk.com/*'],
  },
  database: {
    name: 'Database (REST)', systems: ['database'], color: '#336791', glyph: 'DB',
    fields: [
      { key: 'endpoint', label: 'REST endpoint', placeholder: 'https://db.example.com/rest/v1', help: 'Any PostgREST-compatible API that allows CORS from this site.' },
      { key: 'headerName', label: 'Auth header name', placeholder: 'Authorization' },
      { key: 'headerValue', label: 'Auth header value', placeholder: 'Bearer …', secret: true },
    ],
    transport: 'direct-or-relay',
  },
  api: {
    name: 'Custom REST API', systems: ['api'], color: '#6366F1', glyph: '{}',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' },
      { key: 'headerName', label: 'Auth header name', placeholder: 'Authorization' },
      { key: 'headerValue', label: 'Auth header value', placeholder: 'Bearer …', secret: true },
      { key: 'docs', label: 'What can this API do? (shown to the employee)', placeholder: 'GET /leads lists new leads; POST /leads/{id}/status updates status…', multiline: true },
    ],
    transport: 'direct-or-relay',
  },
  webhook: {
    name: 'Outgoing Webhook', systems: ['webhook'], color: '#0EA5E9', glyph: '↗',
    fields: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.zapier.com/…', secret: true },
      { key: 'description', label: 'What does this webhook do?', placeholder: 'Creates a row in our lead tracker', multiline: true },
    ],
    transport: 'direct-or-relay',
  },
};

const props = (o) => clean(S(o));

// ----------------------------------------------------------------- Tools
export const TOOLS = [
  // Internal tools – always scoped to the employee's own data (employee isolation).
  { name: 'memory_search', system: 'memory', scope: 'read', internal: true,
    description: "Search this employee's memory (instructions, business info, long-term notes, previous results) and granted knowledge files.",
    input_schema: props({ query: str('What to look for') }) },
  { name: 'memory_save', system: 'memory', scope: 'write', internal: true,
    description: 'Save a durable fact to long-term memory so future tasks can use it.',
    input_schema: props({ content: str('The fact or note to remember'), kind: opt(str('long_term | business | task', { enum: ['long_term', 'business', 'task'] })) }) },
  { name: 'record_metric', system: 'metrics', scope: 'write', internal: true,
    description: 'Increment a business metric for reporting, e.g. leads_processed, meetings_booked, tickets_resolved.',
    input_schema: props({ metric: str('snake_case metric key'), value: opt({ type: 'number', description: 'Amount to add (default 1)' }) }) },
  { name: 'request_human_help', system: 'human', scope: 'send', internal: true,
    description: 'Escalate to a human. Pauses the task until a person responds. Use for ambiguity, risk, policy questions or failures you cannot resolve.',
    input_schema: props({ question: str('What you need the human to decide or provide'), context: opt(str('Relevant details')) }),
    summarize: (a) => `needs help: ${a.question}` },
  { name: 'schedule_followup', system: 'scheduler', scope: 'create', internal: true,
    description: 'Schedule a future task for this employee (e.g. a follow-up in 3 days). Runs while WorkForce is open in a browser.',
    input_schema: props({ delay_minutes: { type: 'number', description: 'Minutes from now' }, instruction: str('What the employee should do then'), entry_script: opt(str('Script id to start from')) }),
    summarize: (a) => `schedule a follow-up in ${a.delay_minutes} min: ${a.instruction}` },
  { name: 'notify_user', system: 'human', scope: 'read', internal: true,
    description: 'Send an in-app notification / report to the business owner.',
    input_schema: props({ title: str('Short title'), message: str('Notification body (markdown allowed)') }) },

  // Files
  { name: 'files_search', system: 'files', scope: 'read',
    description: 'Full-text search across the knowledge files this employee may read.',
    input_schema: props({ query: str('Search query') }) },
  { name: 'files_read', system: 'files', scope: 'read',
    description: 'Read the text of a granted knowledge file by id (from files_search results).',
    input_schema: props({ file_id: str('File id') }) },

  // Gmail
  { name: 'gmail_search', system: 'gmail', scope: 'read',
    description: 'Search Gmail using Gmail query syntax (e.g. "is:unread newer_than:1d label:inbox"). Returns message ids, senders, subjects and snippets.',
    input_schema: props({ query: str('Gmail search query'), max_results: opt({ type: 'number', description: 'Default 10' }) }) },
  { name: 'gmail_read', system: 'gmail', scope: 'read',
    description: 'Read a Gmail message (headers and plain-text body) by id.',
    input_schema: props({ message_id: str('Gmail message id') }) },
  { name: 'gmail_send', system: 'gmail', scope: 'send',
    description: 'Send an email from the connected Gmail account.',
    input_schema: props({ to: str('Recipient email(s), comma separated'), subject: str('Subject'), body: str('Plain-text body'), cc: opt(str('CC')), thread_id: opt(str('Reply within this thread id')) }),
    summarize: (a) => `send an email to ${a.to} — “${a.subject}”` },

  // Calendar
  { name: 'calendar_list_events', system: 'google_calendar', scope: 'read',
    description: 'List events on the primary calendar in a time window (ISO 8601).',
    input_schema: props({ time_min: str('Start ISO datetime'), time_max: str('End ISO datetime'), query: opt(str('Free-text filter')) }) },
  { name: 'calendar_create_event', system: 'google_calendar', scope: 'create',
    description: 'Create a calendar event / meeting and invite attendees.',
    input_schema: props({ summary: str('Title'), start: str('Start ISO datetime with timezone offset'), end: str('End ISO datetime with timezone offset'), attendees: opt({ type: 'array', items: { type: 'string' }, description: 'Attendee emails' }), description: opt(str('Agenda / notes')) }),
    summarize: (a) => `create the event “${a.summary}” at ${a.start}${a.attendees?.length ? ` with ${a.attendees.join(', ')}` : ''}` },

  // Drive / Sheets
  { name: 'drive_search', system: 'google_drive', scope: 'read',
    description: 'Search Google Drive file names and contents.',
    input_schema: props({ query: str('Text to search for') }) },
  { name: 'drive_read', system: 'google_drive', scope: 'read',
    description: 'Read a Drive file as text (Google Docs/Sheets are exported).',
    input_schema: props({ file_id: str('Drive file id') }) },
  { name: 'sheets_read', system: 'google_sheets', scope: 'read',
    description: 'Read a range from a Google Sheet.',
    input_schema: props({ spreadsheet_id: str('Spreadsheet id'), range: str('A1 range, e.g. Leads!A1:F50') }) },
  { name: 'sheets_append', system: 'google_sheets', scope: 'write',
    description: 'Append rows to a Google Sheet.',
    input_schema: props({ spreadsheet_id: str('Spreadsheet id'), range: str('Target sheet/range, e.g. Leads!A1'), rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Rows of cell values' } }),
    summarize: (a) => `append ${a.rows?.length || 0} row(s) to sheet ${a.range}` },

  // Slack
  { name: 'slack_post_message', system: 'slack', scope: 'send',
    description: 'Post a message to a Slack channel (id or #name) the bot is in.',
    input_schema: props({ channel: str('Channel id or name'), text: str('Message text') }),
    summarize: (a) => `post to Slack ${a.channel}: “${String(a.text || '').slice(0, 80)}”` },
  { name: 'slack_read_channel', system: 'slack', scope: 'read',
    description: 'Read recent messages from a Slack channel id.',
    input_schema: props({ channel: str('Channel id'), limit: opt({ type: 'number' }) }) },

  // HubSpot
  { name: 'hubspot_search', system: 'hubspot', scope: 'read',
    description: 'Search HubSpot CRM objects (contacts, companies, deals) by free text.',
    input_schema: props({ object_type: str('contacts | companies | deals', { enum: ['contacts', 'companies', 'deals'] }), query: str('Search text') }) },
  { name: 'hubspot_create', system: 'hubspot', scope: 'write',
    description: 'Create a HubSpot CRM object with properties.',
    input_schema: props({ object_type: str('contacts | companies | deals', { enum: ['contacts', 'companies', 'deals'] }), properties: { type: 'object', description: 'Property name → value' } }),
    summarize: (a) => `create a HubSpot ${a.object_type} record` },
  { name: 'hubspot_update', system: 'hubspot', scope: 'write',
    description: 'Update a HubSpot CRM object by id.',
    input_schema: props({ object_type: str('contacts | companies | deals', { enum: ['contacts', 'companies', 'deals'] }), id: str('Record id'), properties: { type: 'object', description: 'Property name → value' } }),
    summarize: (a) => `update HubSpot ${a.object_type} ${a.id}` },

  // Salesforce
  { name: 'salesforce_query', system: 'salesforce', scope: 'read',
    description: 'Run a SOQL query.',
    input_schema: props({ soql: str('SOQL query') }) },
  { name: 'salesforce_create', system: 'salesforce', scope: 'write',
    description: 'Create a Salesforce record.',
    input_schema: props({ sobject: str('Object API name, e.g. Lead'), fields: { type: 'object', description: 'Field → value' } }),
    summarize: (a) => `create a Salesforce ${a.sobject} record` },
  { name: 'salesforce_update', system: 'salesforce', scope: 'write',
    description: 'Update a Salesforce record by id.',
    input_schema: props({ sobject: str('Object API name'), id: str('Record id'), fields: { type: 'object', description: 'Field → value' } }),
    summarize: (a) => `update Salesforce ${a.sobject} ${a.id}` },

  // Shopify
  { name: 'shopify_list', system: 'shopify', scope: 'read',
    description: 'List Shopify orders, products or customers.',
    input_schema: props({ resource: str('orders | products | customers', { enum: ['orders', 'products', 'customers'] }), params: opt({ type: 'object', description: 'Query params, e.g. {"status":"any","limit":10}' }) }) },
  { name: 'shopify_update', system: 'shopify', scope: 'write',
    description: 'Update a Shopify order, product or customer by id.',
    input_schema: props({ resource: str('orders | products | customers', { enum: ['orders', 'products', 'customers'] }), id: str('Record id'), data: { type: 'object', description: 'Fields to update' } }),
    summarize: (a) => `update Shopify ${a.resource} ${a.id}` },

  // Notion
  { name: 'notion_search', system: 'notion', scope: 'read',
    description: 'Search Notion pages and databases shared with the integration.',
    input_schema: props({ query: str('Search text') }) },
  { name: 'notion_create_page', system: 'notion', scope: 'write',
    description: 'Create a Notion page under a parent page.',
    input_schema: props({ parent_page_id: str('Parent page id'), title: str('Title'), content: str('Plain-text content (paragraphs separated by blank lines)') }),
    summarize: (a) => `create the Notion page “${a.title}”` },

  // Zendesk
  { name: 'zendesk_search', system: 'zendesk', scope: 'read',
    description: 'Search Zendesk tickets/users with Zendesk search syntax.',
    input_schema: props({ query: str('e.g. "type:ticket status:open"') }) },
  { name: 'zendesk_create_ticket', system: 'zendesk', scope: 'write',
    description: 'Create a support ticket.',
    input_schema: props({ subject: str('Subject'), body: str('Description'), requester_email: opt(str('Requester email')), priority: opt(str('low | normal | high | urgent')) }),
    summarize: (a) => `create the Zendesk ticket “${a.subject}”` },
  { name: 'zendesk_update_ticket', system: 'zendesk', scope: 'write',
    description: 'Add a comment and/or change status of a ticket.',
    input_schema: props({ id: str('Ticket id'), comment: opt(str('Comment text')), public: opt({ type: 'boolean', description: 'Public reply to customer' }), status: opt(str('open | pending | solved')) }),
    summarize: (a) => `update Zendesk ticket ${a.id}${a.public ? ' with a public reply' : ''}` },

  // Database / API / Webhook
  { name: 'db_select', system: 'database', scope: 'read',
    description: 'Select rows from a table via the REST endpoint (PostgREST query string syntax).',
    input_schema: props({ table: str('Table name'), query: opt(str('e.g. select=*&status=eq.new&limit=20')) }) },
  { name: 'db_insert', system: 'database', scope: 'write',
    description: 'Insert rows into a table.',
    input_schema: props({ table: str('Table name'), rows: { type: 'array', items: { type: 'object' }, description: 'Rows to insert' } }),
    summarize: (a) => `insert ${a.rows?.length || 0} row(s) into ${a.table}` },
  { name: 'api_request', system: 'api', scope: 'read', scopeFor: (a) => (String(a.method || 'GET').toUpperCase() === 'GET' ? 'read' : 'write'),
    description: 'Call the connected custom REST API. Path is relative to its base URL.',
    input_schema: props({ method: str('HTTP method', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }), path: str('Path, e.g. /leads?status=new'), body: opt({ type: 'object', description: 'JSON body' }) }),
    summarize: (a) => `${a.method} ${a.path} on the custom API` },
  { name: 'webhook_send', system: 'webhook', scope: 'send',
    description: 'POST a JSON payload to the configured outgoing webhook.',
    input_schema: props({ payload: { type: 'object', description: 'JSON payload' } }),
    summarize: () => 'send data to the outgoing webhook' },

  // Web research
  { name: 'web_fetch', system: 'web', scope: 'read',
    description: 'Fetch a public web page and return its readable text (company websites, docs, news).',
    input_schema: props({ url: str('https:// URL') }) },

  // Browser (executed by the WorkForce extension in the selected tab)
  { name: 'browser_read_page', system: 'browser', scope: 'read',
    description: 'Read the current tab: URL, title, visible text and interactive elements with ref ids.',
    input_schema: props({}) },
  { name: 'browser_extract', system: 'browser', scope: 'extract',
    description: 'Extract text from elements matching a CSS selector in the current tab.',
    input_schema: props({ selector: str('CSS selector'), limit: opt({ type: 'number' }) }) },
  { name: 'browser_navigate', system: 'browser', scope: 'navigate',
    description: 'Navigate the working tab to a URL (must be within the allowed domains).',
    input_schema: props({ url: str('URL') }),
    summarize: (a) => `navigate the browser to ${a.url}` },
  { name: 'browser_click', system: 'browser', scope: 'click',
    description: 'Click an element by ref id from browser_read_page.',
    input_schema: props({ ref: str('Element ref id'), description: opt(str('What this click does')) }),
    summarize: (a) => `click ${a.description ? `“${a.description}”` : `element ${a.ref}`} in the browser` },
  { name: 'browser_fill', system: 'browser', scope: 'form_input',
    description: 'Type a value into an input/textarea/select by ref id.',
    input_schema: props({ ref: str('Element ref id'), value: str('Value to enter'), field: opt(str('Field label')) }),
    summarize: (a) => `enter “${String(a.value).slice(0, 60)}” into ${a.field || `field ${a.ref}`}` },
  { name: 'browser_scroll', system: 'browser', scope: 'read',
    description: 'Scroll the working tab up or down one screen.',
    input_schema: props({ direction: str('up | down', { enum: ['up', 'down'] }) }) },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

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

export function toolScope(tool, args = {}) {
  return tool.scopeFor ? tool.scopeFor(args) : tool.scope;
}

export function describeAction(tool, args = {}) {
  if (tool.summarize) {
    try { return tool.summarize(args); } catch { /* fall through */ }
  }
  return `use ${tool.name.replace(/_/g, ' ')}`;
}

// Compact catalog text for prompts.
export function catalogForPrompt() {
  return TOOLS.filter((t) => !t.internal)
    .map((t) => `- ${t.name} [${t.system}:${t.scope}] ${t.description}`)
    .join('\n');
}
