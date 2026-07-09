// NOTE: Never hardcode API keys in source. Set COMPOSIO_API_KEY in a local .env
// file (already gitignored) or as a real environment variable before running the app.
const USER_ID = process.env.COMPOSIO_USER_ID || 'pg-test-ecad251a-3da8-462b-a086-46806af14cb4';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

let composioInstance = null;
let ComposioClass = null;
let cachedTools = null; // Map<slug, toolInfo>
let cachedToolkitSummary = null;
let cachedToolkitSummaryTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes // [{ name, toolCount, description }]

async function loadModule() {
  if (!ComposioClass) {
    const mod = await import('@composio/core');
    ComposioClass = mod.Composio;
  }
  return ComposioClass;
}

async function getComposio() {
  if (!COMPOSIO_API_KEY) {
    throw new Error('COMPOSIO_API_KEY is not set. Add it to your .env file.');
  }
  if (!composioInstance) {
    const Composio = await loadModule();
    composioInstance = new Composio({ apiKey: COMPOSIO_API_KEY, dangerouslyAllowAutoUploadDownloadFiles: true });
  }
  return composioInstance;
}

const DEFAULT_TOOLKITS = ['github', 'gmail', 'googlesuper', 'notion', 'linkedin'];

const TOOLKIT_DESCRIPTIONS = {
  github: 'Create repos, issues, pull requests, manage collaborators',
  gmail: 'Send emails, fetch messages, manage drafts and threads',
  googlesuper: 'Unified Google platform — Drive, Calendar, Tasks, Sheets, Analytics, Ads, Photos, Maps, YouTube, Contacts, and more',
  notion: 'Create pages, retrieve content, update databases',
  linkedin: 'Get profile info, create posts, manage content'
};

/**
 * Get a lightweight summary of available toolkits.
 * Returns toolkit names and tool counts only — no full tool list.
 * Uses only fast raw API calls (no enum).
 */
async function getToolkitSummary() {
  if (cachedToolkitSummary && (Date.now() - cachedToolkitSummaryTime < CACHE_TTL_MS)) {
    return cachedToolkitSummary;
  }

  try {
    const composio = await getComposio();
    const summary = [];

    for (const tk of DEFAULT_TOOLKITS) {
      try {
        const tools = await composio.tools.getRawComposioTools({ toolkits: [tk] });
        summary.push({
          name: tk,
          displayName: tk.charAt(0).toUpperCase() + tk.slice(1),
          toolCount: tools.length,
          description: TOOLKIT_DESCRIPTIONS[tk] || ''
        });
      } catch (e) {
        console.error(`[Composio] Failed to get summary for "${tk}":`, e.message);
      }
    }

    cachedToolkitSummary = summary;
    cachedToolkitSummaryTime = Date.now();
    return summary;
  } catch (e) {
    console.error('[Composio] Failed to get toolkit summary:', e.message);
    return [];
  }
}

/**
 * Get full tools for a specific toolkit.
 */
async function getToolsForToolkit(toolkit) {
  try {
    const tools = await getToolsForPrompt([toolkit]);
    return tools;
  } catch (e) {
    console.error(`[Composio] Failed to get tools for "${toolkit}":`, e.message);
    return [];
  }
}

/**
 * Get available tools, formatted for the system prompt.
 */
async function getToolsForPrompt(toolkits) {
  try {
    const composio = await getComposio();
    const kits = toolkits && toolkits.length > 0 ? toolkits : DEFAULT_TOOLKITS;

    // Fetch enum once for all toolkits
    let allEnumSlugs = [];
    try {
      const enumResult = await composio.tools.getToolsEnum();
      allEnumSlugs = Object.values(enumResult).filter(s => typeof s === 'string');
    } catch {}

    const allTools = [];
    const toolMap = new Map();
    for (const tk of kits) {
      try {
        const tools = await composio.tools.getRawComposioTools({ toolkits: [tk] });
        for (const t of tools) {
          const info = {
            name: t.name || t.slug,
            slug: t.slug,
            description: t.description || '',
            inputSchema: t.inputParameters || t.inputSchema || {},
            toolkit: typeof t.toolkit === 'string' ? t.toolkit : (t.toolkit?.name || t.toolkit?.slug || tk),
            version: t.version || ''
          };
          allTools.push(info);
          toolMap.set(info.slug, info);
        }

        // Find tools with empty input schemas
        const toolkitPrefix = tk.toUpperCase() + '_';
        const missingSlugs = allEnumSlugs.filter(s => 
          s.startsWith(toolkitPrefix) && !toolMap.has(s)
        );
        
        const prioritized = [
          ...missingSlugs.filter(s => !s.includes('_ADS_')),
          ...missingSlugs.filter(s => s.includes('_ADS_'))
        ];
        
        for (const slug of prioritized.slice(0, 30)) {
          try {
            const tool = await composio.tools.getRawComposioToolBySlug(slug);
            if (tool) {
              const info = {
                name: tool.name || slug,
                slug: tool.slug,
                description: tool.description || '',
                inputSchema: tool.inputParameters || tool.inputSchema || {},
                toolkit: tk,
                version: tool.version || ''
              };
              allTools.push(info);
              toolMap.set(info.slug, info);
            }
          } catch {}
        }
      } catch (e) {
        console.error(`[Composio] Failed to fetch toolkit "${tk}":`, e.message);
      }
    }

    cachedTools = toolMap;
    return allTools;
  } catch (e) {
    console.error('[Composio] Failed to get tools:', e.message);
    return [];
  }
}

/**
 * Build a lightweight tool prompt — just toolkit names, not full tool list.
 */
function buildToolPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  // Group by toolkit for count
  const byToolkit = {};
  for (const t of tools) {
    const tk = t.toolkit || 'other';
    if (!byToolkit[tk]) byToolkit[tk] = [];
    byToolkit[tk].push(t);
  }

  const toolkitList = Object.entries(byToolkit)
    .map(([tk, tkTools]) => `${tk.charAt(0).toUpperCase() + tk.slice(1)} (${tkTools.length} tools)`)
    .join(', ');

  return `

## Available External Tools (via Composio)
You have access to these services: ${toolkitList}.

IMPORTANT: Tool slugs are UPPERCASE_SNAKE_CASE (e.g., GOOGLESUPER_INSERT_TASK, GMAIL_SEND_EMAIL).
To use a tool, output: [TOOL_CALL: TOOL_SLUG({"param1": "value1"})]

Example: To create a task named "DSA" due July 20:
[TOOL_CALL: GOOGLESUPER_INSERT_TASK({"title": "DSA", "due": "2026-07-20", "tasklist_id": "@default"})]

When the user asks "what tools do you have" or "show me your tools", list ONLY the service names above with a brief description of each. Do NOT list individual tool slugs unless the user specifically asks for them.

When the user asks about a specific service (e.g. "what can you do with gmail?"), list the available tools for that service with their REQUIRED and optional parameters.

Rules:
- Only call tools when the user explicitly asks for an action.
- Tool calls must be on their own line with valid JSON arguments.
- You MUST include all REQUIRED parameters (marked as such when you ask about a service).
- If a tool fails because the service is not connected, ask for confirmation to connect it.
- NEVER guess a tool slug. Only use exact slugs from the tool list.`;
}

/**
 * Build a detailed tool list for a specific toolkit (on-demand).
 */
function buildToolkitDetailPrompt(tools, toolkit) {
  if (!tools || tools.length === 0) return `No tools available for ${toolkit}.`;

  const toolList = tools.map(t => {
    const schema = t.inputSchema || {};
    const properties = schema.properties || {};
    const required = schema.required || [];
    
    // Show required params first, then optional
    const requiredParams = required.filter(p => properties[p]);
    const optionalParams = Object.keys(properties).filter(p => !required.includes(p));
    
    const requiredStr = requiredParams.length > 0
      ? `\n  REQUIRED: ${requiredParams.join(', ')}`
      : '';
    const optionalStr = optionalParams.length > 0
      ? `\n  Optional: ${optionalParams.join(', ')}`
      : '';
    
    const desc = t.description.substring(0, 150);
    return `- ${t.slug}: ${desc}${requiredStr}${optionalStr}`;
  }).join('\n\n');

  return `### ${toolkit.charAt(0).toUpperCase() + toolkit.slice(1)} Tools (${tools.length})\n\n${toolList}`;
}

/**
 * Parse tool call(s) from AI output.
 */
function parseToolCall(text) {
  const calls = parseToolCalls(text);
  return calls.length > 0 ? calls[0] : null;
}

function parseToolCalls(text) {
  if (!text) return [];
  const results = [];
  const regex = /\[TOOL_CALL:\s*(\w+)\((.*?)\)\]/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const toolName = match[1];
    const argsStr = match[2].trim();
    let args = {};

    if (argsStr) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        const legacyRegex = /(\w+)\s*:\s*"([^"]*)"/g;
        let m;
        while ((m = legacyRegex.exec(argsStr)) !== null) {
          args[m[1]] = m[2];
        }
      }
    }

    results.push({ toolName, args });
  }
  return results;
}

/**
 * Execute a tool call via Composio.
 */
async function executeTool(toolName, args) {
  let toolkitName = '';

  try {
    const composio = await getComposio();

    if (!cachedTools || cachedTools.size === 0) {
      await getToolsForPrompt();
    }

    // Resolve the correct slug - try exact match first, then fuzzy match
    let resolvedSlug = toolName;
    const tool = cachedTools?.get(toolName);

    if (!tool) {
      // Try case-insensitive match
      const upperSlug = toolName.toUpperCase();
      const toolFromUpper = cachedTools?.get(upperSlug);
      if (toolFromUpper) {
        resolvedSlug = upperSlug;
      } else {
        // Try to find a partial match (e.g., "create_task" → "GOOGLESUPER_INSERT_TASK")
        const searchParts = toolName.toLowerCase().split('_');
        let bestMatch = null;
        let bestScore = 0;

        for (const [slug, info] of cachedTools.entries()) {
          const slugLower = slug.toLowerCase();
          let score = 0;

          // Check if all search parts appear in the slug
          for (const part of searchParts) {
            if (slugLower.includes(part)) {
              score++;
            }
          }

          // Prefer exact toolkit prefix match
          if (slug.startsWith(toolName.split('_')[0].toUpperCase())) {
            score += 10;
          }

          if (score > bestScore && score >= searchParts.length) {
            bestScore = score;
            bestMatch = slug;
          }
        }

        if (bestMatch) {
          resolvedSlug = bestMatch;
          console.log(`[Composio] Resolved "${toolName}" → "${resolvedSlug}"`);
        }
      }
    }

    if (tool) toolkitName = tool.toolkit || '';

    // Try to fix common parameter mistakes
    const resolvedTool = cachedTools?.get(resolvedSlug);
    if (resolvedTool && resolvedTool.inputSchema) {
      const schema = resolvedTool.inputSchema;
      const required = schema.required || [];
      const properties = schema.properties || {};

      // Map common wrong param names to correct ones
      const PARAM_ALIASES = {
        'text': 'title',
        'name': 'title',
        'content': 'body',
        'message': 'body',
        'email': 'recipient_email',
        'to_email': 'recipient_email',
        'from': 'sender_email'
      };

      const fixedArgs = {};
      for (const [key, value] of Object.entries(args || {})) {
        const correctKey = PARAM_ALIASES[key] || key;
        fixedArgs[correctKey] = value;
      }

      // Fix tasklist_id format: "default" → "@default"
      if (fixedArgs.tasklist_id && !fixedArgs.tasklist_id.startsWith('@')) {
        fixedArgs.tasklist_id = '@' + fixedArgs.tasklist_id;
      }

      // Add default tasklist_id for Google Tasks if missing
      if (resolvedSlug.includes('INSERT_TASK') && !fixedArgs.tasklist_id) {
        fixedArgs.tasklist_id = '@default';
      }

      // Remove params that don't belong to this tool
      const validParams = Object.keys(properties);
      for (const key of Object.keys(fixedArgs)) {
        if (!validParams.includes(key)) {
          console.log(`[Composio] Removing invalid param "${key}" from ${resolvedSlug}`);
          delete fixedArgs[key];
        }
      }

      args = fixedArgs;
    }

    const result = await composio.tools.execute(resolvedSlug, {
      userId: USER_ID,
      arguments: args || {},
      dangerouslySkipVersionCheck: true
    });

    if (result && result.successful === false) {
      throw new Error(result.error || 'Execution failed');
    }

    return { success: true, result: result?.data ?? result };
  } catch (e) {
    console.error(`[Composio] Tool execution failed (${toolName}):`, e.message);

    const msg = e.message || '';

    if (/connected account|not connected|UNAUTHORIZED|no such connection/i.test(msg)) {
      return {
        success: false,
        error: {
          type: 'NOT_CONNECTED',
          toolkit: toolkitName || 'unknown',
          message: `${toolkitName || 'This service'} is not connected.`,
          suggestion: `I need to connect your ${toolkitName || 'external'} account. Should I open the authorization page?`
        }
      };
    }

    if (/not found|does not exist|invalid tool/i.test(msg)) {
      // Try to extract toolkit from slug prefix
      const parts = toolName.split('_');
      if (parts.length >= 2 && !toolkitName) {
        toolkitName = parts[0].toLowerCase();
      }

      return {
        success: false,
        error: {
          type: 'TOOL_NOT_FOUND',
          toolkit: toolkitName || 'unknown',
          message: `Tool "${toolName}" not found.`,
          suggestion: toolkitName
            ? `This tool may not exist in ${toolkitName}, or the service may not be connected. Would you like me to check?`
            : 'This tool may not be available in your Composio plan.'
        }
      };
    }

    if (/rate.limit|too many requests|429/i.test(msg)) {
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

    // Catch confusing errors about unrelated fields
    if (/missing.*calendar_id|missing.*role|missing.*scope/i.test(msg)) {
      return {
        success: false,
        error: {
          type: 'INVALID_PARAMS',
          toolkit: toolkitName || 'unknown',
          message: `Tool "${toolName}" received unexpected parameters.`,
          suggestion: 'The API returned an error about fields that do not belong to this tool. Please check the tool parameters and try again.'
        }
      };
    }

    return {
      success: false,
      error: {
        type: 'EXECUTION_FAILED',
        toolkit: toolkitName || 'unknown',
        message: msg,
        suggestion: 'Check the error details and try again.'
      }
    };
  }
}

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
  try {
    const composio = await getComposio();
    const connections = await composio.connectedAccounts.list({
      toolkitSlugs: [toolkit],
      userIds: [USER_ID]
    });
    return connections?.items || [];
  } catch (e) {
    console.error('[Composio] Failed to get connection status:', e.message);
    return [];
  }
}

async function getConnectUrl(toolkit) {
  try {
    const composio = await getComposio();
    const connectionRequest = await composio.toolkits.authorize(USER_ID, toolkit);
    return connectionRequest?.redirectUrl || null;
  } catch (e) {
    console.error('[Composio] Failed to get connect URL:', e.message);
    return null;
  }
}

async function startConnect(toolkit) {
  const url = await getConnectUrl(toolkit);
  if (!url) {
    throw new Error(`Failed to get authorization URL for ${toolkit}.`);
  }
  return { url, toolkit };
}

async function waitForConnection(toolkit, timeoutMs = 120000) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    const connected = await isConnected(toolkit);
    if (connected) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

module.exports = {
  getToolkitSummary,
  getToolsForToolkit,
  getToolsForPrompt,
  buildToolPrompt,
  buildToolkitDetailPrompt,
  parseToolCall,
  parseToolCalls,
  executeTool,
  isConnected,
  getConnectionStatus,
  getConnectUrl,
  startConnect,
  waitForConnection,
  USER_ID
};
