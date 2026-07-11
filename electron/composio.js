// electron/composio.js
//
// Composio integration layer for Bob.
//
// NOTE: Never hardcode API keys in source. Set COMPOSIO_API_KEY in a local .env
// file (already gitignored) or as a real environment variable before running the app.
//
// This module is responsible for:
//   1. Talking to the Composio SDK (tool discovery, execution, connected accounts).
//   2. Building the system-prompt fragments the LLM uses to know what it can call.
//   3. Parsing [TOOL_CALL: ...] directives out of model output, safely.
//   4. Validating arguments against each tool's real JSON schema before execution.
//   5. Auto-discovering toolkits that are NOT in the user's default set (or not yet
//      connected on the Composio dashboard) so a request like "post this to Slack"
//      doesn't just dead-end with "tool not found" — instead Bob searches the full
//      Composio catalog, and, after explicit user confirmation, connects it.

const USER_ID = process.env.COMPOSIO_USER_ID || 'pg-test-ecad251a-3da8-462b-a086-46806af14cb4';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

let composioInstance = null;
let ComposioClass = null;

// slug -> tool info (name, slug, description, inputSchema, toolkit, version)
let cachedTools = new Map();

// toolkit slug -> { name, toolCount, description, fetchedAt }
let cachedToolkitSummary = null;
let cachedToolkitSummaryTime = 0;

// Full Composio catalog (all toolkits Composio supports, not just the user's default set).
// Used only for discovery ("is there a toolkit that matches what the user asked for?").
let cachedCatalog = null;
let cachedCatalogTime = 0;

const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — toolkit catalog changes rarely

// Composio's tools.getRawComposioTools defaults to only 20 tools per call. A
// toolkit like `googlesuper` exposes ~467 tools, so the default silently drops
// the vast majority — including GOOGLESUPER_INSERT_TASK — which then can't be
// resolved or executed. Always request the full set explicitly.
const TOOL_FETCH_LIMIT = 999;

const DEFAULT_TOOLKITS = ['github', 'gmail', 'googlesuper', 'notion', 'linkedin'];

const TOOLKIT_DESCRIPTIONS = {
  github: 'Create repos, issues, pull requests, manage collaborators',
  gmail: 'Send emails, fetch messages, manage drafts and threads',
  googlesuper: 'Unified Google platform — Drive, Calendar, Tasks, Sheets, Analytics, Ads, Photos, Maps, YouTube, Contacts, and more',
  notion: 'Create pages, retrieve content, update databases',
  linkedin: 'Get profile info, create posts, manage content'
};

// ---------------------------------------------------------------------------
// Core client
// ---------------------------------------------------------------------------

async function loadModule() {
  if (!ComposioClass) {
    const mod = await import('@composio/core');
    ComposioClass = mod.Composio;
  }
  return ComposioClass;
}

async function getComposio() {
  if (!COMPOSIO_API_KEY) {
    throw new Error(
      'COMPOSIO_API_KEY is not set. Add it to your .env file (see .env.example) before using external tools.'
    );
  }
  if (!composioInstance) {
    const Composio = await loadModule();
    composioInstance = new Composio({
      apiKey: COMPOSIO_API_KEY,
      dangerouslyAllowAutoUploadDownloadFiles: true
    });
  }
  return composioInstance;
}

function isConfigured() {
  return Boolean(COMPOSIO_API_KEY);
}

// ---------------------------------------------------------------------------
// Toolkit summary (for the system prompt) — cheap, cached, only default toolkits
// ---------------------------------------------------------------------------

/**
 * Get a lightweight summary of the user's default toolkits.
 * Returns toolkit names and tool counts only — no full tool list.
 */
async function getToolkitSummary() {
  if (cachedToolkitSummary && (Date.now() - cachedToolkitSummaryTime < SUMMARY_CACHE_TTL_MS)) {
    return cachedToolkitSummary;
  }

  const composio = await getComposio();
  const summary = [];

  const results = await Promise.allSettled(
    DEFAULT_TOOLKITS.map(async (tk) => {
      const tools = await composio.tools.getRawComposioTools({ toolkits: [tk], limit: TOOL_FETCH_LIMIT });
      return {
        name: tk,
        displayName: displayName(tk),
        toolCount: tools.length,
        description: TOOLKIT_DESCRIPTIONS[tk] || ''
      };
    })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      summary.push(r.value);
    } else {
      console.error(`[Composio] Failed to summarize toolkit "${DEFAULT_TOOLKITS[i]}":`, r.reason?.message || r.reason);
    }
  }

  cachedToolkitSummary = summary;
  cachedToolkitSummaryTime = Date.now();
  return summary;
}

function displayName(slug) {
  return slug
    .split(/[_-]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Get full tools for a specific toolkit (already-connected/default toolkits).
 */
async function getToolsForToolkit(toolkit) {
  return getToolsForPrompt([toolkit]);
}

/**
 * Fetch and cache full tool definitions (name, slug, schema) for the given toolkits.
 * Populates `cachedTools` so parseCall/executeTool/validateArgs can resolve slugs
 * and validate arguments without extra round trips.
 */
async function getToolsForPrompt(toolkits) {
  const composio = await getComposio();
  const kits = toolkits && toolkits.length > 0 ? toolkits : DEFAULT_TOOLKITS;

  const allTools = [];

  for (const tk of kits) {
    try {
      const tools = await composio.tools.getRawComposioTools({ toolkits: [tk], limit: TOOL_FETCH_LIMIT });
      for (const t of tools) {
        const info = normalizeTool(t, tk);
        allTools.push(info);
        cachedTools.set(info.slug, info);
      }
    } catch (e) {
      console.error(`[Composio] Failed to fetch toolkit "${tk}":`, e.message);
    }
  }

  return allTools;
}

function normalizeTool(t, fallbackToolkit) {
  return {
    name: t.name || t.slug,
    slug: t.slug,
    description: t.description || '',
    inputSchema: t.inputParameters || t.inputSchema || { type: 'object', properties: {}, required: [] },
    toolkit: typeof t.toolkit === 'string' ? t.toolkit : (t.toolkit?.name || t.toolkit?.slug || fallbackToolkit),
    version: t.version || ''
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a lightweight tool prompt — just toolkit names, not the full tool list.
 */
function buildToolPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  const byToolkit = {};
  for (const t of tools) {
    const tk = t.toolkit || 'other';
    if (!byToolkit[tk]) byToolkit[tk] = [];
    byToolkit[tk].push(t);
  }

  const toolkitList = Object.entries(byToolkit)
    .map(([tk, tkTools]) => `${displayName(tk)} (${tkTools.length} tools)`)
    .join(', ');

  let exampleLine = '';
  if (tools.length > 0) {
    const ex = tools[0];
    const schema = ex.inputSchema || {};
    const props = schema.properties || {};
    const required = schema.required || [];
    const sampleArgs = {};
    for (const key of required.slice(0, 3)) {
      sampleArgs[key] = `<${key}>`;
    }
    exampleLine = `\nExample — ${ex.description || ex.slug}:\n[TOOL_CALL: ${ex.slug}(${JSON.stringify(sampleArgs)})]\n`;
  }

  return `

## Available External Tools (via Composio)
You have access to these connected services: ${toolkitList}.

IMPORTANT: Tool slugs are UPPERCASE_SNAKE_CASE (e.g., GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE).
To use a tool, output exactly one line in this format:
[TOOL_CALL: TOOL_SLUG({"param1": "value1"})]
${exampleLine}
When the user asks "what tools do you have" or "show me your tools", list ONLY the service names above with a brief description of each. Do NOT list individual tool slugs unless the user specifically asks for them.

TOOL USAGE RULES — READ CAREFULLY:
- When the user asks to PERFORM an action (e.g., "send a mail", "create a task", "post on LinkedIn", "fetch my emails"), execute the tool DIRECTLY. Do NOT call LIST_TOOLKIT_TOOLS first — just execute the tool with the right parameters.
- Only call LIST_TOOLKIT_TOOLS when the user explicitly asks to SEE or LIST what operations are available (e.g., "what can you do with gmail?", "list Gmail tools", "show me LinkedIn operations").
- "Send a mail to john@gmail.com" = ACTION. Execute GMAIL_SEND_EMAIL immediately with the recipient, subject, and body.
- "Create a task called DSA" = ACTION. Execute the task creation tool immediately.
- "What can Gmail do?" = INFORMATIONAL. Call LIST_TOOLKIT_TOOLS first.
- "Show me LinkedIn tools" = INFORMATIONAL. Call LIST_TOOLKIT_TOOLS first.
- NEVER call LIST_TOOLKIT_TOOLS before an action. It wastes time and annoys the user.

If the user asks for something that needs a service NOT in the list above (e.g. Slack, Trello, Discord, Salesforce), do NOT say you can't help. Instead output:
[TOOL_CALL: DISCOVER_TOOLKIT({"query": "<short description of the requested service or action>"})]
This searches the full Composio catalog for a matching toolkit. If a match is found, Bob will ask the user to confirm before connecting it — never connect anything without confirmation.

Rules:
- Only call tools when the user explicitly asks for an action.
- Tool calls must be on their own line with valid, complete JSON arguments (no trailing commas, no comments).
- You MUST include all REQUIRED parameters. If you don't know a required value, ask the user first instead of guessing.
- If a tool fails because the service is not connected, ask for confirmation to connect it — Bob will handle the authorization flow.
- NEVER guess a tool slug that wasn't given to you. To find a tool inside an ALREADY-CONNECTED service (github, gmail, googlesuper, notion, linkedin), use LIST_TOOLKIT_TOOLS for that service — do NOT use DISCOVER_TOOLKIT for services you already have. Only use DISCOVER_TOOLKIT for services that are NOT in your connected list.

Common tool slugs (use these EXACTLY):
- LinkedIn post: LINKEDIN_CREATE_LINKED_IN_POST (params: author is auto-resolved, commentary is the post text)
- LinkedIn article share: LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE
- Gmail send: GMAIL_SEND_EMAIL (params: recipient_email, subject, body)
- GitHub issue: GITHUB_CREATE_AN_ISSUE
- Google Tasks: GOOGLESUPER_INSERT_TASK (params: title, tasklist_id: "@default")`;
}

/**
 * Build a detailed tool list for a specific toolkit (on-demand, e.g. "what can you do with gmail?").
 */
function buildToolkitDetailPrompt(tools, toolkit) {
  if (!tools || tools.length === 0) return `No tools available for ${toolkit}.`;

  const toolList = tools.map(t => {
    const schema = t.inputSchema || {};
    const properties = schema.properties || {};
    const required = schema.required || [];

    const requiredParams = required.filter(p => properties[p]);
    const optionalParams = Object.keys(properties).filter(p => !required.includes(p));

    const requiredStr = requiredParams.length > 0 ? `\n  REQUIRED: ${requiredParams.join(', ')}` : '';
    const optionalStr = optionalParams.length > 0 ? `\n  Optional: ${optionalParams.join(', ')}` : '';
    const desc = (t.description || '').substring(0, 150);

    return `- ${t.slug}: ${desc}${requiredStr}${optionalStr}`;
  }).join('\n\n');

  return `### ${displayName(toolkit)} Tools (${tools.length})\n\n${toolList}`;
}

// ---------------------------------------------------------------------------
// Parsing tool calls out of model output
// ---------------------------------------------------------------------------

/**
 * Parse tool call(s) from AI output.
 * Handles nested braces/brackets inside the JSON argument payload correctly by
 * scanning for balanced parentheses instead of a naive non-greedy regex, which
 * previously broke on any argument value containing ")" or nested "{...}".
 */
function parseToolCalls(text) {
  if (!text) return [];
  const results = [];
  const marker = '[TOOL_CALL:';
  let searchFrom = 0;

  while (true) {
    const start = text.indexOf(marker, searchFrom);
    if (start === -1) break;

    // Find the tool name right after the marker.
    let i = start + marker.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
    const toolName = text.slice(nameStart, i);

    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '(') {
      // Malformed call — skip past the marker and keep scanning.
      searchFrom = start + marker.length;
      continue;
    }
    const argsStart = i + 1;

    // Find the matching closing paren for this call, respecting string literals.
    let depth = 1;
    let j = argsStart;
    let inString = false;
    let stringChar = '';
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (inString) {
        if (c === '\\') { j += 2; continue; }
        if (c === stringChar) inString = false;
      } else {
        if (c === '"' || c === "'") { inString = true; stringChar = c; }
        else if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      j++;
    }
    const argsEnd = j - 1; // index of the matching ')'

    // Expect a closing ']' shortly after.
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    const consumedEnd = text[k] === ']' ? k + 1 : j;

    const argsStr = text.slice(argsStart, argsEnd).trim();
    let args = {};
    let parseError = null;

    if (argsStr) {
      try {
        args = JSON.parse(argsStr);
      } catch (e) {
        try {
          args = JSON.parse(argsStr.replace(/'/g, '"'));
        } catch {
          parseError = e.message;
          const legacyRegex = /"?(\w+)"?\s*:\s*"([^"]*)"/g;
          let m;
          while ((m = legacyRegex.exec(argsStr)) !== null) {
            args[m[1]] = m[2];
          }
        }
      }
    }

    if (toolName) {
      results.push({ toolName, args, raw: text.slice(start, consumedEnd), parseError: Object.keys(args).length ? null : parseError });
    }
    searchFrom = consumedEnd;
  }

  return results;
}

function parseToolCall(text) {
  const calls = parseToolCalls(text);
  return calls.length > 0 ? calls[0] : null;
}

// ---------------------------------------------------------------------------
// Argument normalization + validation
// ---------------------------------------------------------------------------

// Conservative aliasing — only applied when the tool schema does NOT already
// have the key the model used, and DOES have the aliased target. This avoids
// silently overwriting a correct argument the model already got right.
// Each key maps to an array of possible targets (checked in order).
const PARAM_ALIASES = {
  text: ['commentary', 'title', 'body'],
  name: ['title', 'name'],
  content: ['body', 'content'],
  message: ['body', 'message'],
  email: ['recipient_email', 'email'],
  to_email: ['recipient_email', 'to'],
  from: ['sender_email', 'from']
};

/**
 * Reconcile the model's arguments against the tool's real input schema:
 *  - map known aliases only when it actually helps
 *  - drop parameters the tool doesn't accept (rather than sending them and
 *    letting the API return a confusing error)
 *  - apply a couple of narrowly-scoped formatting fixes (e.g. Google Tasks'
 *    "@default" tasklist convention)
 *  - report which required parameters are still missing so the caller can
 *    surface a clear, actionable error instead of a raw API failure
 */
function reconcileArgs(tool, rawArgs) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const required = schema.required || [];
  const validKeys = new Set(Object.keys(properties));

  const args = { ...(rawArgs || {}) };
  const fixed = {};
  const dropped = [];

  for (const [key, value] of Object.entries(args)) {
    let targetKey = key;
    if (!validKeys.has(key) && PARAM_ALIASES[key]) {
      const aliases = Array.isArray(PARAM_ALIASES[key]) ? PARAM_ALIASES[key] : [PARAM_ALIASES[key]];
      for (const alias of aliases) {
        if (validKeys.has(alias)) { targetKey = alias; break; }
      }
    }

    if (validKeys.size > 0 && !validKeys.has(targetKey)) {
      dropped.push(key);
      continue;
    }

    fixed[targetKey] = value;
  }

  // Google Tasks convention: the primary list is addressed as "@default".
  // Models often pass the bare word "default" — normalize just that one case.
  // Real list IDs are opaque strings (e.g. "MDQ1NTEz...") and must be left
  // untouched, so we only rewrite the literal "default"/"@default", never
  // arbitrary values.
  if (typeof fixed.tasklist_id === 'string') {
    const tl = fixed.tasklist_id.trim();
    if (tl === 'default' || tl === '@default' || tl === '') {
      fixed.tasklist_id = '@default';
    }
  }
  // If a Google Tasks tool requires a tasklist_id and none was supplied, fall
  // back to the user's default list rather than failing on a missing param.
  if (validKeys.has('tasklist_id') && required.includes('tasklist_id') && !fixed.tasklist_id) {
    fixed.tasklist_id = '@default';
  }

  const missing = required.filter(r => fixed[r] === undefined || fixed[r] === null || fixed[r] === '');

  return { args: fixed, dropped, missing };
}

// ---------------------------------------------------------------------------
// Tool resolution (exact slug, case-insensitive, then fuzzy match)
// ---------------------------------------------------------------------------

// Explicit slug aliases — common wrong slugs the model invents, mapped to the
// real slug. Checked BEFORE fuzzy matching so the right tool is always chosen.
const SLUG_ALIASES = {
  // LinkedIn
  'LINKEDIN_CREATE_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_MAKE_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_NEW_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_ADD_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_SEND_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_SHARE_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_POST': 'LINKEDIN_CREATE_LINKED_IN_POST',
  'LINKEDIN_CREATE_ARTICLE': 'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE',
  'LINKEDIN_SHARE_ARTICLE': 'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE',
  // Gmail
  'GMAIL_CREATE_EMAIL': 'GMAIL_SEND_EMAIL',
  'GMAIL_NEW_EMAIL': 'GMAIL_SEND_EMAIL',
  'GMAIL_SEND_MESSAGE': 'GMAIL_SEND_EMAIL',
  'GMAIL_COMPOSE': 'GMAIL_SEND_EMAIL',
  // Google Tasks
  'GOOGLESUPER_CREATE_TASK': 'GOOGLESUPER_INSERT_TASK',
  'GOOGLESUPER_ADD_TASK': 'GOOGLESUPER_INSERT_TASK',
  'GOOGLESUPER_NEW_TASK': 'GOOGLESUPER_INSERT_TASK',
  // GitHub
  'GITHUB_CREATE_ISSUE': 'GITHUB_CREATE_AN_ISSUE',
  'GITHUB_NEW_ISSUE': 'GITHUB_CREATE_AN_ISSUE',
  'GITHUB_MAKE_ISSUE': 'GITHUB_CREATE_AN_ISSUE',
};

async function ensureToolsLoaded() {
  if (!cachedTools || cachedTools.size === 0) {
    await getToolsForPrompt(DEFAULT_TOOLKITS);
  }
}

// Local models routinely invent a plausible-but-wrong slug for an action —
// e.g. GOOGLESUPER_CREATE_TASK (real slug is ..._INSERT_TASK) or
// LINKEDIN_GET_PROFILE (real slug is ..._GET_PERSON). These groups let a
// guessed verb/noun match its real synonym so the call resolves instead of
// dead-ending. Each set is a cluster of interchangeable words; a search part
// matches a slug part if they fall in the same cluster.
const WORD_SYNONYMS = [
  ['create', 'insert', 'add', 'new', 'make'],
  ['get', 'fetch', 'retrieve', 'read', 'show', 'view'],
  ['list', 'all', 'search', 'find'],
  ['update', 'patch', 'edit', 'modify', 'change'],
  ['delete', 'remove', 'clear', 'trash'],
  ['send', 'post', 'share', 'publish'],
  ['profile', 'person', 'me', 'account', 'user'],
  ['task', 'tasks'],
  ['message', 'messages', 'email', 'emails', 'mail'],
  ['repo', 'repos', 'repository', 'repositories'],
  ['issue', 'issues'],
  ['file', 'files', 'document', 'documents', 'doc', 'docs'],
  ['event', 'events'],
  ['page', 'pages']
];

const SYNONYM_INDEX = (() => {
  const idx = new Map();
  for (const group of WORD_SYNONYMS) {
    for (const w of group) idx.set(w, group);
  }
  return idx;
})();

function wordsMatch(a, b) {
  if (a === b) return true;
  const group = SYNONYM_INDEX.get(a);
  return group ? group.includes(b) : false;
}

function resolveSlug(toolName) {
  if (cachedTools.has(toolName)) return toolName;

  const upper = toolName.toUpperCase();
  if (cachedTools.has(upper)) return upper;

  // Check explicit aliases first — guaranteed correct match.
  const aliasTarget = SLUG_ALIASES[upper] || SLUG_ALIASES[toolName];
  if (aliasTarget && cachedTools.has(aliasTarget)) return aliasTarget;

  const searchParts = toolName.toLowerCase().split('_').filter(Boolean);
  if (searchParts.length === 0) return toolName;
  const impliedToolkit = searchParts[0];

  let bestMatch = null;
  let bestScore = -1;

  for (const slug of cachedTools.keys()) {
    const slugParts = slug.toLowerCase().split('_').filter(Boolean);

    // Count how many of the model's parts have an exact or synonym match in
    // this slug (each slug part consumed at most once).
    const usedSlugIdx = new Set();
    let exactHits = 0;
    let synonymHits = 0;
    for (const part of searchParts) {
      let matchedIdx = -1;
      let matchedExact = false;
      for (let s = 0; s < slugParts.length; s++) {
        if (usedSlugIdx.has(s)) continue;
        if (slugParts[s] === part) { matchedIdx = s; matchedExact = true; break; }
        if (matchedIdx === -1 && wordsMatch(part, slugParts[s])) matchedIdx = s;
      }
      if (matchedIdx !== -1) {
        usedSlugIdx.add(matchedIdx);
        if (matchedExact) exactHits++; else synonymHits++;
      }
    }

    const totalHits = exactHits + synonymHits;

    // Require the toolkit prefix to line up and at least one action word
    // (beyond the toolkit) to match — otherwise this isn't a real candidate.
    const toolkitAligned = slugParts[0] === impliedToolkit || wordsMatch(impliedToolkit, slugParts[0]);
    if (!toolkitAligned) continue;
    if (totalHits < 2) continue; // toolkit + at least one meaningful part

    // Score: exact matches are worth more than synonym matches; reward covering
    // all of the model's parts; penalize slugs padded with many extra words.
    let score = exactHits * 3 + synonymHits * 2;
    if (totalHits >= searchParts.length) score += 6; // every requested part accounted for
    const extraParts = slugParts.length - totalHits;
    score -= extraParts;
    if (slugParts.length === searchParts.length) score += 3;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = slug;
    }
  }

  return bestMatch || toolName;
}

// ---------------------------------------------------------------------------
// Toolkit auto-discovery for services not in the user's default set
// ---------------------------------------------------------------------------

/**
 * Fetch (and cache) the full Composio toolkit catalog — every toolkit Composio
 * supports, regardless of whether the user has it connected or in their
 * default set. Used purely for discovery/search, never for execution directly.
 */
async function getFullCatalog() {
  if (cachedCatalog && (Date.now() - cachedCatalogTime < CATALOG_CACHE_TTL_MS)) {
    return cachedCatalog;
  }

  const composio = await getComposio();
  const items = [];
  let cursor;

  do {
    const page = await composio.toolkits.get({ cursor, limit: 200 });
    if (Array.isArray(page)) {
      items.push(...page);
      break;
    }
    const pageItems = page?.items || page?.data || [];
    items.push(...pageItems);
    cursor = page?.nextCursor || page?.next_cursor || undefined;
  } while (cursor && items.length < 2000);

  cachedCatalog = items;
  cachedCatalogTime = Date.now();
  return items;
}

/**
 * Given a free-text description of what the user wants ("post a message to a
 * Slack channel"), find the best-matching toolkit in the full Composio catalog
 * that is NOT already one of the user's default/connected toolkits.
 */
async function discoverToolkit(query) {
  const catalog = await getFullCatalog();
  const q = (query || '').toLowerCase();
  const qWords = q.split(/\W+/).filter(w => w.length > 2);

  let best = null;
  let bestScore = 0;

  for (const tk of catalog) {
    const slug = (tk.slug || tk.name || '').toLowerCase();
    const name = (tk.name || tk.slug || '').toLowerCase();
    const desc = (tk.description || tk.meta?.description || '').toLowerCase();

    let score = 0;
    if (q.includes(slug) || q.includes(name)) score += 10;
    for (const w of qWords) {
      if (slug.includes(w) || name.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = tk;
    }
  }

  if (!best || bestScore < 3) return null;

  return {
    slug: best.slug || best.name,
    name: best.name || best.slug,
    description: best.description || best.meta?.description || '',
    alreadyDefault: DEFAULT_TOOLKITS.includes((best.slug || '').toLowerCase())
  };
}

/**
 * Register a newly-approved toolkit into the active toolkit set for this
 * session so its tools become callable without restarting the app, and
 * refresh the toolkit summary shown in the system prompt.
 */
async function activateToolkit(toolkitSlug) {
  if (!DEFAULT_TOOLKITS.includes(toolkitSlug)) {
    DEFAULT_TOOLKITS.push(toolkitSlug);
  }
  await getToolsForPrompt([toolkitSlug]);
  cachedToolkitSummary = null;
  cachedToolkitSummaryTime = 0;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Cache for the user's LinkedIn person URN
let cachedLinkedInURN = null;

/**
 * Get the user's LinkedIn person URN for auto-filling the author parameter.
 * Fetches once and caches for the session.
 */
async function getLinkedInAuthorURN(composio) {
  if (cachedLinkedInURN) return cachedLinkedInURN;

  try {
    const result = await composio.tools.execute('LINKEDIN_GET_MY_INFO', {
      userId: USER_ID,
      arguments: {},
      dangerouslySkipVersionCheck: true
    });

    const data = result?.data || result;
    const id = data?.id;
    if (id) {
      cachedLinkedInURN = `urn:li:person:${id}`;
      return cachedLinkedInURN;
    }
  } catch (e) {
    console.error('[Composio] Failed to auto-resolve LinkedIn author URN:', e.message);
  }
  return null;
}

/**
 * Execute a tool call via Composio, with schema validation, argument
 * reconciliation, and structured, actionable error reporting.
 */
async function executeTool(toolName, args) {
  // Special pseudo-tools the model uses to drive the discovery/connect flow.
  if (toolName === 'DISCOVER_TOOLKIT') {
    return handleDiscoverToolkit(args);
  }
  if (toolName === 'CONNECT_TOOLKIT') {
    return handleConnectToolkit(args);
  }
  if (toolName === 'LIST_TOOLKIT_TOOLS') {
    return handleListToolkitTools(args);
  }

  let toolkitName = '';

  try {
    if (!isConfigured()) {
      return {
        success: false,
        error: {
          type: 'NOT_CONFIGURED',
          toolkit: 'unknown',
          message: 'Composio is not configured on this machine.',
          suggestion: 'Set COMPOSIO_API_KEY in your .env file, then restart Bob.'
        }
      };
    }

    const composio = await getComposio();
    await ensureToolsLoaded();

    const resolvedSlug = resolveSlug(toolName);
    const tool = cachedTools.get(resolvedSlug);

    if (!tool) {
      const guess = toolName.split('_')[0].toLowerCase();
      const searchParts = toolName.toLowerCase().split('_').filter(Boolean);
      const sameToolkitTools = [];
      for (const [slug, info] of cachedTools.entries()) {
        if (slug.toLowerCase().startsWith(guess + '_') || (info.toolkit && info.toolkit.toLowerCase() === guess)) {
          sameToolkitTools.push(slug);
        }
      }

      let suggestion;
      if (sameToolkitTools.length > 0) {
        const actionParts = searchParts.slice(1);
        const scored = sameToolkitTools.map(slug => {
          const slugLower = slug.toLowerCase();
          let relevance = 0;
          for (const part of actionParts) {
            if (slugLower.includes(part)) relevance++;
          }
          if (actionParts.length > 0) {
            const slugAction = slugLower.split('_').slice(1).join('_');
            const searchAction = actionParts.join('_');
            if (slugAction === searchAction) relevance += 10;
          }
          return { slug, relevance };
        });
        scored.sort((a, b) => b.relevance - a.relevance);
        const relevant = scored.filter(s => s.relevance > 0).slice(0, 8).map(s => s.slug);
        const display = relevant.length > 0 ? relevant : scored.slice(0, 6).map(s => s.slug);
        suggestion = `Tool "${toolName}" doesn't exist. Did you mean one of these?\n${display.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nUse the exact slug from the list above.`;
      } else {
        const discovered = await discoverToolkit(`${toolName} ${guess}`).catch(() => null);
        suggestion = discovered
          ? `Did you mean the "${discovered.name}" service? I can search the Composio catalog and connect it — just confirm.`
          : `This tool doesn't exist in your current toolkits (${DEFAULT_TOOLKITS.join(', ')}). Try [TOOL_CALL: DISCOVER_TOOLKIT({"query": "..."})] to search for the right service.`;
      }

      return {
        success: false,
        error: {
          type: 'TOOL_NOT_FOUND',
          toolkit: guess,
          message: `Tool "${toolName}" was not found among your connected toolkits.`,
          suggestion,
          availableTools: sameToolkitTools.length > 0 ? sameToolkitTools : null
        }
      };
    }

    toolkitName = tool.toolkit || '';

    const { args: fixedArgs, dropped, missing } = reconcileArgs(tool, args);

    // Auto-resolve LinkedIn author URN for post/comment tools
    if (resolvedSlug.startsWith('LINKEDIN_CREATE') && !fixedArgs.author) {
      fixedArgs.author = await getLinkedInAuthorURN(composio);
      if (!fixedArgs.author) {
        return {
          success: false,
          error: {
            type: 'MISSING_REQUIRED_PARAMS',
            toolkit: 'linkedin',
            message: '"author" is required but could not be auto-resolved. Make sure your LinkedIn account is connected.',
            suggestion: 'Connect your LinkedIn account first, then retry.'
          }
        };
      }
      // Remove author from missing if it was there
      const authorIdx = missing.indexOf('author');
      if (authorIdx !== -1) missing.splice(authorIdx, 1);
    }

    if (dropped.length > 0) {
      console.log(`[Composio] Dropped unsupported params for ${resolvedSlug}: ${dropped.join(', ')}`);
    }

    if (missing.length > 0) {
      return {
        success: false,
        error: {
          type: 'MISSING_REQUIRED_PARAMS',
          toolkit: toolkitName,
          message: `"${resolvedSlug}" is missing required parameter(s): ${missing.join(', ')}.`,
          suggestion: `Ask the user for: ${missing.join(', ')}, then retry the call with those values included.`
        }
      };
    }

    const connected = await isConnected(toolkitName).catch(() => true); // fail open if the check itself errors
    if (!connected) {
      return {
        success: false,
        error: {
          type: 'NOT_CONNECTED',
          toolkit: toolkitName,
          message: `${displayName(toolkitName)} is not connected.`,
          suggestion: `I need to connect your ${displayName(toolkitName)} account. Should I open the authorization page?`
        }
      };
    }

    const result = await composio.tools.execute(resolvedSlug, {
      userId: USER_ID,
      arguments: fixedArgs,
      dangerouslySkipVersionCheck: true
    });

    if (result && result.successful === false) {
      throw new Error(result.error || 'Execution failed');
    }

    return { success: true, result: result?.data ?? result };
  } catch (e) {
    return classifyExecutionError(toolName, toolkitName, e);
  }
}

/**
 * List the real tools available inside an already-connected toolkit. This is
 * what the model calls when the user asks "what can you do with linkedin?" so
 * it presents actual slugs/parameters instead of hallucinating a tool list.
 */
async function handleListToolkitTools(args) {
  const raw = (args?.toolkit || args?.query || '').toString().toLowerCase().trim();
  if (!raw) {
    return {
      success: false,
      error: {
        type: 'INVALID_PARAMS',
        toolkit: 'unknown',
        message: 'LIST_TOOLKIT_TOOLS requires a "toolkit" parameter.',
        suggestion: 'Retry with one of: ' + DEFAULT_TOOLKITS.join(', ') + '.'
      }
    };
  }

  // Map common aliases to the real toolkit slug (e.g. "google"/"tasks" ->
  // googlesuper, "google tasks" -> googlesuper).
  const ALIASES = {
    google: 'googlesuper', 'google tasks': 'googlesuper', tasks: 'googlesuper',
    calendar: 'googlesuper', drive: 'googlesuper', sheets: 'googlesuper',
    gmail: 'gmail', mail: 'gmail', email: 'gmail',
    git: 'github', github: 'github',
    notion: 'notion', linkedin: 'linkedin'
  };
  const toolkit = DEFAULT_TOOLKITS.includes(raw) ? raw : (ALIASES[raw] || raw);

  if (!DEFAULT_TOOLKITS.includes(toolkit)) {
    return {
      success: false,
      error: {
        type: 'TOOL_NOT_FOUND',
        toolkit,
        message: `"${raw}" is not one of your connected services.`,
        suggestion: `Connected services are: ${DEFAULT_TOOLKITS.join(', ')}. If you want a different one, use DISCOVER_TOOLKIT.`
      }
    };
  }

  try {
    const tools = await getToolsForToolkit(toolkit);
    if (!tools || tools.length === 0) {
      return {
        success: false,
        error: {
          type: 'EXECUTION_FAILED',
          toolkit,
          message: `Couldn't load tools for ${displayName(toolkit)}.`,
          suggestion: 'The service may be temporarily unavailable. Try again in a moment.'
        }
      };
    }

    const detail = buildToolkitDetailPrompt(tools, toolkit);
    return {
      success: true,
      result: {
        toolkit,
        toolCount: tools.length,
        // The renderer shows this text directly; the model can also read it to
        // answer follow-ups accurately with real slugs and parameters.
        tools: detail
      }
    };
  } catch (e) {
    console.error(`[Composio] LIST_TOOLKIT_TOOLS failed for "${toolkit}":`, e.message);
    return {
      success: false,
      error: {
        type: 'EXECUTION_FAILED',
        toolkit,
        message: `Failed to list tools for ${displayName(toolkit)}.`,
        suggestion: e.message
      }
    };
  }
}

async function handleDiscoverToolkit(args) {
  const query = args?.query || '';
  if (!query) {
    return {
      success: false,
      error: {
        type: 'INVALID_PARAMS',
        toolkit: 'unknown',
        message: 'DISCOVER_TOOLKIT requires a "query" parameter.',
        suggestion: 'Retry with a short description of the requested service or action.'
      }
    };
  }

  try {
    const found = await discoverToolkit(query);
    if (!found) {
      return {
        success: false,
        error: {
          type: 'NO_MATCHING_TOOLKIT',
          toolkit: 'unknown',
          message: `No Composio toolkit matched "${query}".`,
          suggestion: 'Let the user know this integration is not available through Composio, and ask if they want something else instead.'
        }
      };
    }

    if (found.alreadyDefault) {
      return {
        success: true,
        result: {
          alreadyAvailable: true,
          toolkit: found.slug,
          message: `${found.name} is already available — no need to connect anything.`
        }
      };
    }

    return {
      success: false,
      error: {
        type: 'TOOLKIT_FOUND_NEEDS_CONFIRMATION',
        toolkit: found.slug,
        message: `Found a matching service: ${found.name}.`,
        suggestion: `${found.description || ''} Ask the user to confirm before connecting. If they confirm, call [TOOL_CALL: CONNECT_TOOLKIT({"toolkit": "${found.slug}"})]. Never connect without explicit confirmation.`,
        discovered: found
      }
    };
  } catch (e) {
    console.error('[Composio] Toolkit discovery failed:', e.message);
    return {
      success: false,
      error: {
        type: 'DISCOVERY_FAILED',
        toolkit: 'unknown',
        message: 'Failed to search the Composio toolkit catalog.',
        suggestion: e.message
      }
    };
  }
}

async function handleConnectToolkit(args) {
  const toolkit = (args?.toolkit || '').toLowerCase();
  if (!toolkit) {
    return {
      success: false,
      error: {
        type: 'INVALID_PARAMS',
        toolkit: 'unknown',
        message: 'CONNECT_TOOLKIT requires a "toolkit" parameter.',
        suggestion: 'Use the toolkit slug returned by DISCOVER_TOOLKIT.'
      }
    };
  }

  try {
    const { url } = await connectDiscoveredToolkit(toolkit);
    return {
      success: true,
      result: {
        toolkit,
        authUrl: url,
        message: `Opening the authorization page for ${displayName(toolkit)}. Once the user finishes connecting, its tools will be available immediately.`
      }
    };
  } catch (e) {
    console.error(`[Composio] Failed to connect discovered toolkit "${toolkit}":`, e.message);
    return {
      success: false,
      error: {
        type: 'CONNECT_FAILED',
        toolkit,
        message: `Failed to start authorization for ${displayName(toolkit)}.`,
        suggestion: e.message
      }
    };
  }
}

function classifyExecutionError(toolName, toolkitName, e) {
  const msg = e?.message || String(e);
  console.error(`[Composio] Tool execution failed (${toolName}):`, msg);

  if (/connected account|not connected|UNAUTHORIZED|no such connection/i.test(msg)) {
    return {
      success: false,
      error: {
        type: 'NOT_CONNECTED',
        toolkit: toolkitName || 'unknown',
        message: `${toolkitName ? displayName(toolkitName) : 'This service'} is not connected.`,
        suggestion: `I need to connect your ${toolkitName ? displayName(toolkitName) : 'external'} account. Should I open the authorization page?`
      }
    };
  }

  if (/not found|does not exist|invalid tool/i.test(msg)) {
    const parts = toolName.split('_');
    const guessedToolkit = toolkitName || (parts.length >= 2 ? parts[0].toLowerCase() : '');
    return {
      success: false,
      error: {
        type: 'TOOL_NOT_FOUND',
        toolkit: guessedToolkit || 'unknown',
        message: `Tool "${toolName}" not found.`,
        suggestion: guessedToolkit
          ? `This tool may not exist in ${displayName(guessedToolkit)}, or the service isn't connected yet. Try DISCOVER_TOOLKIT to confirm.`
          : 'This tool may not be available in your Composio plan. Try DISCOVER_TOOLKIT to search the catalog.'
      }
    };
  }

  if (/rate.?limit|too many requests|429/i.test(msg)) {
    return {
      success: false,
      error: {
        type: 'RATE_LIMITED',
        toolkit: toolkitName || 'unknown',
        message: 'Rate limited by the service.',
        suggestion: 'Please wait a moment and try again.'
      }
    };
  }

  if (/missing.*calendar_id|missing.*role|missing.*scope/i.test(msg)) {
    return {
      success: false,
      error: {
        type: 'INVALID_PARAMS',
        toolkit: toolkitName || 'unknown',
        message: `Tool "${toolName}" received unexpected parameters.`,
        suggestion: 'The API rejected fields that do not belong to this tool. Re-check the tool schema and retry with corrected parameters.'
      }
    };
  }

  return {
    success: false,
    error: {
      type: 'EXECUTION_FAILED',
      toolkit: toolkitName || 'unknown',
      message: msg,
      suggestion: 'Check the error details and try again. If this keeps happening, the tool schema may have changed upstream.'
    }
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function isConnected(toolkit) {
  try {
    const accounts = await getConnectionStatus(toolkit);
    return accounts.some(a => a.status === 'ACTIVE');
  } catch (e) {
    console.error(`[Composio] Failed to check connection for "${toolkit}":`, e.message);
    return false;
  }
}

async function getConnectionStatus(toolkit) {
  const composio = await getComposio();
  const connections = await composio.connectedAccounts.list({
    toolkitSlugs: [toolkit],
    userIds: [USER_ID]
  });
  return connections?.items || [];
}

/**
 * Returns a Set of toolkit slugs that have at least one ACTIVE connection.
 * Single API call instead of N individual isConnected() calls.
 */
async function getConnectedToolkitSlugs() {
  const composio = await getComposio();
  try {
    const accounts = await composio.connectedAccounts.list({ userIds: [USER_ID] });
    const items = accounts?.items || [];
    return new Set(
      items.filter(a => a.status === 'ACTIVE').map(a => {
        const t = a.toolkit;
        const slug = typeof t === 'string' ? t : (t?.slug || t?.name || a.appName || '');
        return slug.toLowerCase();
      })
    );
  } catch (e) {
    console.error('[Composio] Failed to list connected accounts:', e.message);
    return new Set();
  }
}

async function getConnectUrl(toolkit) {
  const composio = await getComposio();

  // The old SDK method toolkits.authorize() uses the retired POST /api/v3/connected_accounts
  // endpoint. Use connectedAccounts.link() with POST /api/v3/connected_accounts/link instead.
  const authConfigs = await composio.authConfigs.list({ toolkit });
  let authConfigId = authConfigs?.items?.[0]?.id;

  if (!authConfigId) {
    const created = await composio.authConfigs.create(toolkit, {
      type: 'use_composio_managed_auth',
      name: `${toolkit} Auth Config`
    });
    authConfigId = created.id;
  }

  const connectionRequest = await composio.connectedAccounts.link(USER_ID, authConfigId, { allowMultiple: true });
  return connectionRequest?.redirectUrl || connectionRequest?.redirect_url || null;
}

async function startConnect(toolkit) {
  const url = await getConnectUrl(toolkit);
  if (!url) {
    throw new Error(`Failed to get an authorization URL for ${displayName(toolkit)}. Check that the toolkit slug is correct and that your Composio API key has access to it.`);
  }
  return { url, toolkit };
}

/**
 * Connect a toolkit that was discovered dynamically (not in DEFAULT_TOOLKITS)
 * after the user has explicitly confirmed. On success, the toolkit is
 * activated for the rest of the session so its tools become callable.
 */
async function connectDiscoveredToolkit(toolkit) {
  const { url } = await startConnect(toolkit);
  await activateToolkit(toolkit);
  return { url, toolkit };
}

async function waitForConnection(toolkit, timeoutMs = 120000) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    if (await isConnected(toolkit)) return true;
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

module.exports = {
  isConfigured,
  getToolkitSummary,
  getToolsForToolkit,
  getToolsForPrompt,
  buildToolPrompt,
  buildToolkitDetailPrompt,
  parseToolCall,
  parseToolCalls,
  executeTool,
  discoverToolkit,
  connectDiscoveredToolkit,
  isConnected,
  getConnectionStatus,
  getConnectedToolkitSlugs,
  getConnectUrl,
  startConnect,
  waitForConnection,
  getFullCatalog,
  USER_ID,
  DEFAULT_TOOLKITS,
  // Exposed for tests / diagnostics.
  resolveSlug
};
