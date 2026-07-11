import React, { useEffect, useRef, useState, useCallback } from 'react';
import { isOllamaRunning, startOllama, listModels, getRunningModels, pullModel, warmUpModel, streamChat } from './ollama.js';
import { useVoice } from './useVoice.js';
import { formatToolResultWithHeader } from './formatToolResult.js';

// Remove [TOOL_CALL: NAME({...})] directives so they never render in the
// chat bubble — they are machine instructions, not part of the reply.
function stripToolCalls(text) {
  if (!text) return text;
  return text.replace(/\[TOOL_CALL:[\s\S]*?\)\s*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtml(html) {
  if (!html) return html;
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SYSTEM_PROMPT = `You are Bob — Sagar's closest friend and thinking partner. You run locally on his machine via Ollama (gemma4:31b-cloud), with external tool access via Composio.

## Your Capabilities
- You can speak aloud using Edge TTS (Microsoft's text-to-speech). When the user enables auto-speak, your responses are spoken in real-time using a deep British male voice (en-GB-ThomasNeural).
- You can listen: the user can speak to you via microphone. You receive their speech as text (converted by Whisper STT).
- You remember things across conversations. Past conversations are stored and you can recall facts, stories, goals, and preferences from them. When the user asks "what did we talk about before" or references a past topic, you have access to that context.
- You have external tool access via Composio — including GitHub, Gmail, Google Tasks, Google Drive, Google Calendar, Notion, and LinkedIn. When you need to use a tool, respond with [TOOL_CALL: TOOL_NAME({...})] and the system will execute it for you.
- Tool slugs are UPPERCASE_SNAKE_CASE (e.g., GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE). Always use the exact slug format from the tool list.
- When using a tool, you MUST include all REQUIRED parameters. Common required params: title (for tasks), recipient_email (for emails), subject/body (for emails). Optional params like "due" can be added if the user specifies.
- Example: To create a task named "DSA" due July 20, output: [TOOL_CALL: <TASK_TOOL_SLUG>({"title": "DSA", "due": "2026-07-20", "tasklist_id": "@default"})] — use the actual task tool slug from the available tool list.
- When the user asks "what tools do you have" or "show me your tools", list ONLY the service names (GitHub, Gmail, LinkedIn, etc.) with a brief description. Do NOT list individual tool slugs unless specifically asked.
- Tool usage rules:
  - When the user asks to PERFORM an action (e.g., "send a mail", "create a task", "post on LinkedIn"), execute the tool DIRECTLY. Do NOT call LIST_TOOLKIT_TOOLS first — just do it.
  - Only call LIST_TOOLKIT_TOOLS when the user explicitly asks to SEE what operations are available (e.g., "what can you do with gmail?", "list Gmail tools", "show me LinkedIn operations").
  - "Send a mail to John" = ACTION. Execute GMAIL_SEND_EMAIL immediately.
  - "What can Gmail do?" = INFORMATIONAL. Call LIST_TOOLKIT_TOOLS first.
- Common tool slugs (use these EXACTLY):
  - LinkedIn post: LINKEDIN_CREATE_LINKED_IN_POST (author is auto-resolved, use "commentary" for the post text)
  - Gmail send: GMAIL_SEND_EMAIL (params: recipient_email, subject, body)
  - Gmail list messages: GMAIL_LIST_MESSAGES (params: q for search query)
  - Gmail fetch message by ID: GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID (params: id)
  - Gmail fetch message by thread: GMAIL_FETCH_MESSAGE_BY_THREAD_ID (params: thread_id)
  - Gmail fetch emails: GMAIL_FETCH_EMAILS (params: max_results, user_id)
  - Google Tasks: GOOGLESUPER_INSERT_TASK (params: title, tasklist_id: "@default")
  - GitHub issue: GITHUB_CREATE_AN_ISSUE
  - Write a file: FILE_WRITE({"path": "C:\\Users\\Sagar Karmakar\\...\\file.py", "content": "full file content"})
  - Execute a shell command: SHELL_EXEC({"command": "your command here", "timeout": 30000})
  - Create a scheduled task: SCHEDULE_TASK({"name": "task_name", "script_path": "C:\\path\\to\\script.py", "trigger_time": "08:00", "days": ["friday"]})
- If a tool fails because the service is not connected, ask the user for confirmation to connect it before proceeding.

## Autonomy Rules — CRITICAL
When given a multi-step task, you MUST execute ALL steps without stopping. Never ask "done?", "next?", or wait for user confirmation between steps. Keep going until the entire task is complete.

Examples:
- "Summarize all emails from X and send to Y" = List messages → Fetch each message → Summarize → Send email. Do ALL of this in one response.
- "Create a script and schedule it" = Write file → Create scheduled task. Both in one response.
- "Check my GitHub issues and fix the bug" = List issues → Read issue → Write fix → Create PR. All steps.

Only stop if:
- A tool fails and you need user input to fix it
- You need information from the user that you cannot get from tools
- The task is genuinely impossible

NEVER stop after one tool call and ask "done?" — that is lazy and wastes the user's time. The user expects you to be autonomous and finish what you start.
- You run locally via Ollama for your brain, but your tool access (Composio) connects to cloud services when needed. Edge TTS powers your voice, Whisper powers your ears.

## Local Automation Capabilities
You have full local system access. You can:

1. WRITE FILES to disk using FILE_WRITE. Use this to create Python scripts, batch files, config files, etc. Always use full Windows paths (C:\\Users\\<name>\\...).

2. EXECUTE SHELL COMMANDS using SHELL_EXEC. Use this to run Python scripts, check installed packages, install dependencies (pip install), verify services, etc. Default timeout is 30s, max 120s.

3. CREATE SCHEDULED TASKS using SCHEDULE_TASK. This creates Windows Task Scheduler entries that run scripts on a schedule. Params: name (unique identifier), script_path (full path to .py or .ps1 file), trigger_time (HH:MM format), days (array: "monday", "tuesday", etc.).

IMPORTANT: User's home directory is C:\\Users\\Sagar Karmakar (with a space). Always use this exact path when writing files.
IMPORTANT: Python command is "py" NOT "python". Always use "py" to run Python scripts on this system.

When the user asks to automate something:
- Write the complete, working script first
- Explain what the script does
- Create the scheduled task if they want it recurring
- Verify the setup if possible (check if Python is installed, if Ollama is running, etc.)

## Retry & Resilience Rules
When a tool call fails, do NOT give up immediately. Try up to 3 alternative approaches:

1. First failure: Try a different approach (e.g., if "python" fails, try "py"; if a path fails, try an alternative location; if a tool slug fails, try a similar one).
2. Second failure: Try a completely different method (e.g., if SHELL_EXEC fails, try writing a .bat file and running it; if FILE_WRITE fails to one path, try another).
3. Third failure: Only then report the failure to the user with a clear explanation of what went wrong and what they can do to fix it.

Examples of alternative strategies:
- Command not found: Try alternative command names (python → py → python3)
- Path rejected: Try different allowed paths (Desktop → Documents → Downloads)
- Tool not connected: Try discover + connect flow, or use a different tool
- API timeout: Retry with shorter timeout or smaller batch
- Permission denied: Try running with different flags or in a different directory

Never say "I can't" until you've exhausted all alternatives.

Common automation patterns:
- Weekly briefing: Write Python script that calls Ollama API + Composio → create scheduled task for Friday 8am
- Daily summary: Script that fetches emails/tasks → scheduled task for weekday mornings
- Backup: Script that copies files → scheduled task for daily/weekly
- Monitoring: Script that checks something → scheduled task with appropriate frequency

## Core Identity
- Speak naturally like a real friend.
- Be warm, calm, confident, and intelligent.
- Never sound robotic.
- Never act like a customer support agent.
- Don't overuse emojis, excitement, or fake enthusiasm.
- Keep conversations natural.

## Honesty Above Everything
Always tell the truth as you honestly understand it.

- Never lie to protect feelings.
- Never tell someone what they want to hear.
- Never flatter without good reason.
- Never invent facts.
- If you don't know something, say so.
- If someone is wrong, tell them.
- If they are making excuses, call them excuses.
- If the logic doesn't make sense, explain why.
- If a plan is unrealistic, explain exactly what will fail.
- If expectations are impossible, say so immediately.
- Truth always comes before agreement.

## Challenge, Don't Agree
- Disagree when you genuinely disagree.
- Question assumptions.
- Point out blind spots.
- Offer counterarguments.
- Explain both sides before recommending one.
- Help people think, not just confirm opinions.

## Brutal but Respectful
- Don't sugarcoat reality.
- Be direct, clear, and concise.
- Never insult or belittle.
- Attack bad ideas, never the person.
- When criticism is needed, explain what is wrong, why it is wrong, and how to improve.

## Accountability
- If someone keeps repeating the same mistake, remind them immediately.
- If they procrastinate, call it procrastination.
- If they are avoiding difficult work, tell them.
- If they are making excuses, separate excuses from real obstacles.
- Hold people accountable.

## Problem Solving
- Don't immediately give answers.
- First understand the problem.
- Ask questions when needed.
- Break complicated problems into smaller ones.
- Think step by step.
- Point out tradeoffs.
- Present the strongest recommendation and explain why.

## Task Execution
- When asked to perform a task, execute ALL steps silently without commentary.
- Do NOT explain what you are doing or narrate the process.
- Do NOT show intermediate steps, tool calls, or progress updates.
- ONLY respond with a brief confirmation AFTER the task is fully complete.
- Example: User says "send email to John" → execute all steps → respond "Done. Email sent."
- If the task fails, respond with ONLY the error, not the process.

## Communication Style
- Write like a smart friend.
- Natural, relaxed, confident.
- No corporate language.
- No motivational speeches.
- No fake positivity.
- Avoid cliches and unnecessary apologies.
- NEVER use asterisks, ampersands, or at signs. Use plain English words instead.
- Keep responses focused and useful. Don't ramble unless the conversation calls for it.

## What You Optimize For
Help people become smarter, more disciplined, more skilled, more independent, and better at making decisions. Not happier today at the cost of tomorrow.

## About Sagar Karmakar
- BCA student at Midnapore College (Autonomous), Vidyasagar University, graduating 2026
- Career goal: Software Engineer at Microsoft
- Wants to pursue MSc Computer Science abroad — preferred countries: Germany, Italy, France, Austria, Finland, Ireland, Netherlands
- GitHub: https://github.com/Sagar3039
- Portfolio: https://sagarportfolio2004.netlify.app/
- Email: sagarkarmakar3.10.2004@gmail.com
- Skills: Python, Java, C++, React, FastAPI, Android, Git
- Projects: Bob AI, RacePulse, Portfolio, AI Voice Assistant

## Data Display Rules
- When presenting data from tools, ALWAYS format it as clean, readable text — never raw JSON.
- Show data as labeled fields with clear values (e.g., "Name: John", "Email: john@example.com").
- Only show raw JSON if the user specifically asks for it (e.g., "show me the JSON", "give me raw data").
- For lists, use numbered or bulleted format.
- Keep the data organized and easy to scan at a glance.
- NEVER include raw HTML content from emails or web pages in your responses. Only include plain text summaries.
- If data is nested, flatten it into a readable hierarchy.`;

const DEFAULT_MODEL = 'gemma4:31b-cloud';
const WELCOME_MSG = { role: 'assistant', content: "Hey. What are we working on?" };

// Single source of truth for the default personality so /reset restores the
// exact same values the app starts with.
const DEFAULT_PERSONALITY = {
  name: 'Bob',
  tone: 'warm, calm, confident — like a real friend',
  style: 'direct, honest, no fluff — challenges when needed, supports when needed',
  emoji: false,
  custom: ''
};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Connector icons - emoji fallback for each toolkit
function getConnectorIcon(slug) {
  const icons = {
    gmail: '📧',
    google: '🔍',
    googlesuper: '🔍',
    github: '🐙',
    linkedin: '💼',
    notion: '📝',
    slack: '💬',
    discord: '🎮',
    twitter: '🐦',
    spotify: '🎵',
    youtube: '▶️',
    dropbox: '📦',
    trello: '📋',
    jira: '🎫',
    salesforce: '☁️',
    hubspot: '🟠',
    stripe: '💳',
    airtable: '📊',
    figma: '🎨',
    zoom: '📹',
    calendar: '📅',
    drive: '💾',
    tasks: '✅'
  };
  return icons[slug] || '🔌';
}

/**
 * Parse [TOOL_CALL: NAME({...})] directives out of model output.
 * Mirrors the balanced-paren scanner in electron/composio.js so both sides
 * agree on what counts as a tool call — a naive regex like
 * /\[TOOL_CALL:\s*(\w+)\((.*?)\)\]/gs breaks as soon as an argument value
 * contains a literal ")" or nested braces (e.g. an email subject like
 * "Update (final)"), silently truncating the JSON payload.
 */
async function executeLocalTool(toolName, args) {
  const api = window.assistantAPI;
  try {
    switch (toolName) {
      case 'FILE_WRITE': {
        const res = await api.fs.writeFile(args.path, args.content);
        return res.success
          ? { success: true, result: `File written successfully: ${res.path}` }
          : { success: false, error: { message: res.error } };
      }
      case 'FILE_READ': {
        const res = await api.fs.readFile(args.path);
        return res.success
          ? { success: true, result: res.content }
          : { success: false, error: { message: res.error } };
      }
      case 'SHELL_EXEC': {
        const res = await api.shell.exec(args.command, args.cwd, args.timeout);
        const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
        return res.success
          ? { success: true, result: output || 'Command executed (no output)' }
          : { success: false, error: { message: res.error || 'Command failed', suggestion: output } };
      }
      case 'SCHEDULE_TASK': {
        const res = await api.scheduler.createTask(args.name, args.script_path, args.trigger_time, args.days);
        return res.success
          ? { success: true, result: `Scheduled task "${res.taskName}" created. Runs at ${args.trigger_time} on ${(args.days || ['friday']).join(', ')}.` }
          : { success: false, error: { message: res.error } };
      }
      case 'SCHEDULE_LIST': {
        const res = await api.scheduler.listTasks();
        const list = (res.tasks || []).map(t => `${t.TaskName} — ${t.State}`).join('\n');
        return { success: true, result: list || 'No scheduled tasks found.' };
      }
      case 'SCHEDULE_DELETE': {
        const res = await api.scheduler.deleteTask(args.task_name);
        return res.success
          ? { success: true, result: `Task "${args.task_name}" deleted.` }
          : { success: false, error: { message: res.error } };
      }
      default:
        return { success: false, error: { message: `Unknown local tool: ${toolName}` } };
    }
  } catch (e) {
    return { success: false, error: { message: e.message } };
  }
}

function parseToolCallsClient(text) {
  if (!text) return [];
  const results = [];
  const marker = '[TOOL_CALL:';
  let searchFrom = 0;

  while (true) {
    const start = text.indexOf(marker, searchFrom);
    if (start === -1) break;

    let i = start + marker.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
    const toolName = text.slice(nameStart, i);

    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '(') {
      searchFrom = start + marker.length;
      continue;
    }
    const argsStart = i + 1;

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
    const argsEnd = j - 1;

    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    const consumedEnd = text[k] === ']' ? k + 1 : j;

    const argsStr = text.slice(argsStart, argsEnd).trim();
    let args = {};

    if (argsStr) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        try {
          args = JSON.parse(argsStr.replace(/'/g, '"'));
        } catch {
          const legacyRegex = /"?(\w+)"?\s*:\s*"([^"]*)"/g;
          let m;
          while ((m = legacyRegex.exec(argsStr)) !== null) {
            args[m[1]] = m[2];
          }
        }
      }
    }

    if (toolName) results.push({ toolName, args });
    searchFrom = consumedEnd;
  }

  return results;
}

const api = window.assistantAPI;

async function loadSessions() {
  try {
    if (api?.sessions) return await api.sessions.load();
  } catch {}
  return [];
}

async function saveSessions(sessions) {
  try {
    if (api?.sessions) await api.sessions.save(sessions);
  } catch {}
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export default function App() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState([WELCOME_MSG]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Starting Ollama...');
  const [showLoadPrompt, setShowLoadPrompt] = useState(false);
  const [pullProgress, setPullProgress] = useState('');
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const sessionsLoadedRef = useRef(false);
  const [pendingToolConfirm, setPendingToolConfirm] = useState(null);
  const [copiedMsgId, setCopiedMsgId] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorFilter, setConnectorFilter] = useState('');
  const [connectorTab, setConnectorTab] = useState('all');
  const [settingsTab, setSettingsTab] = useState('general');

  // Personality state
  const [personality, setPersonality] = useState(DEFAULT_PERSONALITY);

  // Command autocomplete
  const COMMANDS = [
    { cmd: '/personality', desc: 'View & edit personality' },
    { cmd: '/name', desc: 'Change name' },
    { cmd: '/tone', desc: 'Change tone' },
    { cmd: '/style', desc: 'Change style' },
    { cmd: '/emoji', desc: 'Toggle emoji on|off' },
    { cmd: '/set', desc: 'Set custom instruction' },
    { cmd: '/reset', desc: 'Reset to default' },
    { cmd: '/clear', desc: 'Clear conversation' },
    { cmd: '/help', desc: 'Show all commands' }
  ];
  const [cmdFilter, setCmdFilter] = useState('');
  const [showCmds, setShowCmds] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  const inputRef = useRef(null);

  // Temp voice settings (only applied on button click)
  const [tempTtsProvider, setTempTtsProvider] = useState('edge');
  const [tempSystemVoice, setTempSystemVoice] = useState(null);
  const [tempRate, setTempRate] = useState(1.0);
  const [tempPitch, setTempPitch] = useState(1.0);
  const [tempEdgeVoice, setTempEdgeVoice] = useState('en-GB-ThomasNeural');
  const [tempEdgeRate, setTempEdgeRate] = useState(0);
  const [tempEdgePitch, setTempEdgePitch] = useState(0);
  const [voiceApplied, setVoiceApplied] = useState(true);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  const { listen, listening, transcribing, sendVoice, cancelRecording, speak, speaking, stopSpeaking, voiceSupported,
    ttsProvider, setTtsProvider,
    systemVoices, selectedSystemVoice, setSelectedSystemVoice,
    rate, setRate, pitch, setPitch,
    edgeVoices, selectedEdgeVoice, setSelectedEdgeVoice,
    edgeRate, setEdgeRate, edgePitch, setEdgePitch,
    edgeVoicesLoading, edgeVoicesError, refreshEdgeVoices,
    pushChunk, flushChunks, clearQueue } = useVoice();

  // Load sessions on mount, then start a fresh conversation
  useEffect(() => {
    loadSessions().then(s => {
      // Filter out empty sessions on load too
      const meaningful = s.filter(sess => sess.messages.length > 1 || sess.messages[0]?.content !== WELCOME_MSG.content);
      setSessions(meaningful);
      sessionsLoadedRef.current = true;

      // Extract memory from all existing sessions in background
      if (api?.memory) {
        for (const sess of meaningful) {
          api.memory.extract(sess).catch(() => {});
        }
      }

      // Always start with a new conversation
      const id = generateId();
      const newSession = {
        id,
        title: 'New Chat',
        messages: [WELCOME_MSG],
        model: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(id);
      setMessages([WELCOME_MSG]);
    });
  }, []);

  // Fetch connectors from Composio
  async function fetchConnectors() {
    if (!api?.composio?.allConnectors) return;
    setConnectorsLoading(true);
    try {
      const list = await api.composio.allConnectors();
      setConnectors(list || []);
    } catch (e) {
      console.error('Failed to fetch connectors:', e);
    }
    setConnectorsLoading(false);
  }

  async function handleConnectToolkit(slug) {
    if (!api?.composio?.startConnect) return;
    try {
      await api.composio.startConnect(slug);
      // Wait a moment then refresh
      setTimeout(fetchConnectors, 3000);
    } catch (e) {
      console.error('Failed to connect:', e);
    }
  }

  // Persist sessions — only after initial load to avoid overwriting file with empty array
  // Skip sessions that only contain the welcome message (no real conversation)
  useEffect(() => {
    if (sessionsLoadedRef.current) {
      const meaningful = sessions.filter(s => s.messages.length > 1 || s.messages[0]?.content !== WELCOME_MSG.content);
      saveSessions(meaningful);
    }
  }, [sessions]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isThinking]);

  // Startup
  useEffect(() => {
    (async () => {
      setStatus('Checking Ollama...');
      let running = await isOllamaRunning();

      if (!running) {
        setStatus('Ollama not found, trying to start it...');
        running = await startOllama();
        if (!running) {
          setError('Could not start Ollama automatically. Please start it manually: ollama serve');
          setStatus('Failed to start Ollama');
          return;
        }
      }

      setStatus('Ollama is up! Checking models...');
      try {
        const loadedModels = await getRunningModels();
        const allModels = await listModels();
        setModels(allModels);

        if (loadedModels.length > 0) {
          setSelectedModel(loadedModels[0]);
          setStatus(`Using loaded model: ${loadedModels[0]}`);
        } else {
          setSelectedModel('');
          setShowLoadPrompt(true);
          setStatus('No models loaded');
        }
      } catch (e) {
        setError('Connected to Ollama but failed to list models.');
        setStatus('Error listing models');
      }
    })();
  }, []);

  // --- Session functions ---
  const createNewSession = useCallback(() => {
    clearQueue();
    const id = generateId();
    const newSession = {
      id,
      title: 'New Chat',
      messages: [WELCOME_MSG],
      model: selectedModel,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(id);
    setMessages([WELCOME_MSG]);
    setShowSidebar(false);
  }, [selectedModel, clearQueue]);

  const loadSession = useCallback((id) => {
    const session = sessions.find(s => s.id === id);
    if (session) {
      clearQueue();
      setCurrentSessionId(id);
      setMessages(session.messages);
      if (session.model) setSelectedModel(session.model);
      setShowSidebar(false);
    }
  }, [sessions, clearQueue]);

  const deleteSession = useCallback((id, e) => {
    e.stopPropagation();
    if (currentSessionId === id) {
      // Deleting the active chat — drop it and immediately start a fresh one
      // so the app never lands in a "no current session" state where new
      // messages silently fail to persist.
      clearQueue();
      const newId = generateId();
      const newSession = {
        id: newId,
        title: 'New Chat',
        messages: [WELCOME_MSG],
        model: selectedModel,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      setSessions(prev => [newSession, ...prev.filter(s => s.id !== id)]);
      setCurrentSessionId(newId);
      setMessages([WELCOME_MSG]);
    } else {
      setSessions(prev => prev.filter(s => s.id !== id));
    }
  }, [currentSessionId, selectedModel, clearQueue]);

  const renameSession = useCallback((id, e) => {
    e.stopPropagation();
    const name = prompt('Rename session:');
    if (name && name.trim()) {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: name.trim() } : s));
    }
  }, []);

  const saveCurrentSession = useCallback(() => {
    if (!currentSessionId) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== currentSessionId) return s;
      const firstUser = s.messages.find(m => m.role === 'user');
      const title = firstUser ? firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? '...' : '') : 'Chat';
      return { ...s, messages, title, model: selectedModel, updatedAt: Date.now() };
    }));
  }, [currentSessionId, messages, selectedModel]);

  // Auto-save on message change + extract memory
  useEffect(() => {
    if (currentSessionId && messages.length > 1) {
      const timer = setTimeout(() => {
        saveCurrentSession();
        // Extract memory from session after save
        const session = sessions.find(s => s.id === currentSessionId);
        if (session && api?.memory) {
          api.memory.extract({ ...session, messages, updatedAt: Date.now() }).catch(() => {});
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [messages, currentSessionId, saveCurrentSession, sessions]);

  // --- Model loading ---
  async function loadDefaultModel() {
    setShowLoadPrompt(false);
    setStatus(`Loading ${DEFAULT_MODEL}...`);
    setPullProgress('Checking model...');

    try {
      const allModels = await listModels();
      const exists = allModels.some(m => m.name === DEFAULT_MODEL || m.name.startsWith(DEFAULT_MODEL + ':'));

      if (!exists) {
        setStatus(`Pulling ${DEFAULT_MODEL} (this may take a while)...`);
        await pullModel(DEFAULT_MODEL, (status, completed, total) => {
          if (total) {
            const pct = Math.round((completed / total) * 100);
            setPullProgress(`${status} ${pct}%`);
          } else {
            setPullProgress(status);
          }
        });
      }

      setStatus(`Loading ${DEFAULT_MODEL} into memory...`);
      setPullProgress('Warming up model...');
      await warmUpModel(DEFAULT_MODEL);

      const updatedModels = await listModels();
      setModels(updatedModels);
      setSelectedModel(DEFAULT_MODEL);
      setPullProgress('');
      setStatus(`Ready! Using: ${DEFAULT_MODEL}`);
    } catch (e) {
      setError(`Failed to load ${DEFAULT_MODEL}: ${e.message}`);
      setStatus('Failed to load model');
      setPullProgress('');
    }
  }

  function cancelLoadModel() {
    setShowLoadPrompt(false);
    setStatus('No model selected. Pick one from the dropdown.');
  }

  // --- Voice settings ---
  function openVoicePanel() {
    // Sync temp state with current values
    setTempTtsProvider(ttsProvider);
    setTempSystemVoice(selectedSystemVoice);
    setTempRate(rate);
    setTempPitch(pitch);
    setTempEdgeVoice(selectedEdgeVoice);
    setTempEdgeRate(edgeRate);
    setTempEdgePitch(edgePitch);
    setVoiceApplied(false);
    setShowSettings(false);
    setShowVoicePanel(true);
  }

  function applyVoiceSettings() {
    setTtsProvider(tempTtsProvider);
    if (tempSystemVoice) setSelectedSystemVoice(tempSystemVoice);
    setRate(tempRate);
    setPitch(tempPitch);
    setSelectedEdgeVoice(tempEdgeVoice);
    setEdgeRate(tempEdgeRate);
    setEdgePitch(tempEdgePitch);
    setVoiceApplied(true);
    setShowVoicePanel(false);
  }

  function cancelVoiceSettings() {
    setVoiceApplied(true);
    setShowVoicePanel(false);
  }

  // --- Commands ---
  function handleCommand(text) {
    const t = text.trim();
    if (!t.startsWith('/')) return false;

    const [cmd, ...args] = t.split(' ');
    const val = args.join(' ').trim();
    const lower = cmd.toLowerCase();

    const commands = {
      '/name': () => {
        if (!val) return 'Current name: ' + personality.name;
        setPersonality(p => ({ ...p, name: val }));
        return `Name changed to "${val}"`;
      },
      '/tone': () => {
        if (!val) return 'Current tone: ' + personality.tone;
        setPersonality(p => ({ ...p, tone: val }));
        return `Tone changed to "${val}"`;
      },
      '/style': () => {
        if (!val) return 'Current style: ' + personality.style;
        setPersonality(p => ({ ...p, style: val }));
        return `Style changed to "${val}"`;
      },
      '/emoji': () => {
        const on = val.toLowerCase();
        const enable = on === 'on' || on === 'true' || on === '1';
        const disable = on === 'off' || on === 'false' || on === '0';
        if (!enable && !disable) return 'Usage: /emoji on|off';
        setPersonality(p => ({ ...p, emoji: enable }));
        return `Emoji ${enable ? 'enabled' : 'disabled'}`;
      },
      '/set': () => {
        if (!val) return 'Usage: /set <instruction> — e.g. "/set respond like a pirate"';
        setPersonality(p => ({ ...p, custom: val }));
        return `Custom instruction set: "${val}"`;
      },
      '/reset': () => {
        setPersonality(DEFAULT_PERSONALITY);
        return 'Personality reset to default.';
      },
      '/personality': () => {
        return `Current personality:\n- Name: ${personality.name}\n- Tone: ${personality.tone}\n- Style: ${personality.style}\n- Emoji: ${personality.emoji ? 'on' : 'off'}\n- Custom: ${personality.custom || '(none)'}\n\nCommands:\n/name <name> — Change name\n/tone <tone> — Change tone\n/style <style> — Change style\n/emoji on|off — Toggle emoji\n/set <instruction> — Set custom instruction\n/reset — Reset to default`;
      },
      '/help': () => {
        return 'Commands:\n/personality — View and edit personality\n/name <name> — Change name\n/tone <tone> — Change tone\n/style <style> — Change style\n/emoji on|off — Toggle emoji\n/set <instruction> — Set custom instruction\n/reset — Reset personality\n/clear — Clear current conversation';
      },
      '/clear': () => {
        setMessages([WELCOME_MSG]);
        return 'Conversation cleared.';
      }
    };

    if (commands[lower]) {
      const result = commands[lower]();
      // Show command result as assistant message
      setMessages(prev => {
        const newMsgs = [...prev];
        // Replace empty assistant placeholder or append
        if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'assistant' && newMsgs[newMsgs.length - 1].content === '') {
          newMsgs[newMsgs.length - 1] = { role: 'assistant', content: result };
        } else {
          newMsgs.push({ role: 'assistant', content: result });
        }
        return newMsgs;
      });
      return true;
    }

    return false;
  }

  // --- Chat ---
  async function sendMessage(text) {
    const content = text.trim();
    if (!content || isThinking || !selectedModel) return;

    setError('');

    // Handle pending tool connection confirmation. Two shapes:
    //  - kind: 'connect'   → toolkit already exists in Bob's default set, just needs OAuth
    //  - kind: 'discovery' → toolkit was found dynamically via DISCOVER_TOOLKIT
    //                        and is NOT yet in Sagar's Composio dashboard/default
    //                        set. Nothing is ever added without this explicit "yes".
    if (pendingToolConfirm) {
      const answer = content.toLowerCase().trim();
      const { toolName, args, toolkit, kind } = pendingToolConfirm;
      const isDiscovery = kind === 'discovery';

      if (answer === 'yes' || answer === 'y' || answer === 'connect') {
        setPendingToolConfirm(null);
        setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: `Opening ${toolkit} authorization page... Please complete the authorization in your browser.` }]);
        setInput('');

        try {
          if (isDiscovery) {
            // Newly-discovered toolkit: connect + activate it for this session.
            await api.composio.connectToolkit(toolkit);
          } else {
            await api.composio.startConnect(toolkit);
          }

          setMessages((prev) => [...prev, { role: 'assistant', content: `Waiting for you to authorize ${toolkit}...` }]);

          const connected = await api.composio.waitForConnection(toolkit, 120000);

          if (connected) {
            setMessages((prev) => [...prev, { role: 'assistant', content: `${toolkit} connected successfully!${toolName ? ` Retrying ${toolName}...` : ''}` }]);

            if (toolName) {
              const retryResult = await api.composio.execute(toolName, args);
              const retryMsg = retryResult.success
                ? `${toolName} completed successfully.\n\nResult:\n${JSON.stringify(retryResult.result, null, 2)}`
                : `${toolName} failed: ${retryResult.error?.message || retryResult.error}`;
              setMessages((prev) => [...prev, { role: 'assistant', content: retryMsg }]);
            }
          } else {
            setMessages((prev) => [...prev, { role: 'assistant', content: `Connection timed out. Please try again later.` }]);
          }
        } catch (e) {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Connection error: ${e.message}` }]);
        }
        return;
      } else if (answer === 'no' || answer === 'n' || answer === 'cancel') {
        setPendingToolConfirm(null);
        setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: `Connection cancelled.` }]);
        setInput('');
        return;
      }
      // If not yes/no, continue with normal message handling
    }

    // Handle commands
    if (handleCommand(content)) {
      setInput('');
      return;
    }

    const newHistory = [...messages, { role: 'user', content }];
    setMessages(newHistory);
    setInput('');
    setIsThinking(true);

    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    const controller = new AbortController();
    abortRef.current = controller;

    // Fetch memory context from past conversations
    let memoryContext = '';
    if (api?.memory) {
      try {
        memoryContext = await api.memory.getContext(content, currentSessionId);
      } catch {}
    }

    // Get Composio tools
    let toolPrompt = '';
    if (api?.composio) {
      try {
        toolPrompt = await api.composio.buildPrompt();
      } catch {}
    }

    // Build dynamic personality prompt
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const personalityBlock = `## Current Identity
You are "${personality.name}" — ${personality.tone}.
Your communication style: ${personality.style}.
Emoji usage: ${personality.emoji ? 'Use emojis naturally in responses.' : 'Do NOT use emojis.'}
${personality.custom ? `Special instruction: ${personality.custom}` : ''}

## Current Date and Time
The current date and time is: ${currentDateTime}
Timezone: ${timezone}
Use this to reference "today", "tomorrow", "yesterday", schedule posts, set due dates, and answer any time-related questions. Always use the user's timezone.`;

    const basePrompt = personalityBlock + '\n\n' + SYSTEM_PROMPT;
    const memoryBlock = memoryContext
      ? `Here is what I remember from past conversations:\n${memoryContext}\n\nNow respond as ${personality.name} with this context available.\n\n${basePrompt}`
      : basePrompt;
    const systemPrompt = memoryBlock + toolPrompt;
    const apiMessages = [{ role: 'system', content: systemPrompt }, ...newHistory];

    let fullReply = '';
    const useStreamingTts = autoSpeak && ttsProvider === 'edge';

    try {
      fullReply = await streamChat(
        selectedModel,
        apiMessages,
        (chunk) => {
          fullReply += chunk;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: fullReply };
            return updated;
          });
          // Stream chunks to TTS as they arrive (Edge only)
          if (useStreamingTts) {
            pushChunk(chunk);
          }
        },
        controller.signal
      );
    } catch (e) {
      if (e.name !== 'AbortError') {
        setError(e.message || 'Something went wrong talking to Ollama.');
      }
    } finally {
      setIsThinking(false);
      if (fullReply && autoSpeak) {
        if (useStreamingTts) {
          flushChunks(); // Play any remaining buffered text
        } else {
          speak(fullReply); // System voice — batch mode
        }
      }

      // Check for Composio tool call(s) in the response — there can be more than one.
      // Uses parseToolCalls (balanced-paren scan), matching electron/composio.js,
      // instead of a regex that breaks on parentheses/nested braces inside args.
      if (fullReply) {
        const toolMatches = parseToolCallsClient(fullReply);
        for (const { toolName, args } of toolMatches) {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Executing ${toolName}...` }]);

          try {
            // Local tools — handled directly via Electron IPC
            const LOCAL_TOOLS = ['FILE_WRITE', 'SHELL_EXEC', 'SCHEDULE_TASK', 'FILE_READ', 'SCHEDULE_LIST', 'SCHEDULE_DELETE'];
            let result;

            if (LOCAL_TOOLS.includes(toolName)) {
              result = await executeLocalTool(toolName, args);
            } else if (api?.composio) {
              result = await api.composio.execute(toolName, args);
            } else {
              result = { success: false, error: { type: 'NOT_CONFIGURED', message: 'No tool backend available.' } };
            }

            if (result.success) {
              // LIST_TOOLKIT_TOOLS returns a human-readable tool listing — show
              // it directly instead of a raw JSON dump.
              const resultMsg = (toolName === 'LIST_TOOLKIT_TOOLS' && result.result?.tools)
                ? result.result.tools
                : formatToolResultWithHeader(result.result, toolName);
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: resultMsg };
                return updated;
              });
              continue;
            }

            const error = result.error;

            if (error && error.type === 'NOT_CONNECTED') {
              setPendingToolConfirm({ toolName, args, toolkit: error.toolkit, kind: 'connect' });
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: `${error.suggestion}\n\nType "yes" to connect ${error.toolkit}, or "no" to cancel.` };
                return updated;
              });
              continue;
            }

            // DISCOVER_TOOLKIT found a service not in Sagar's default set / dashboard.
            // Never connect automatically — require an explicit "yes" first.
            if (error && error.type === 'TOOLKIT_FOUND_NEEDS_CONFIRMATION') {
              const found = error.discovered;
              setPendingToolConfirm({ toolName: null, args: null, toolkit: found?.slug || error.toolkit, kind: 'discovery' });
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: 'assistant',
                  content: `${error.message}${found?.description ? ` — ${found.description}` : ''}\n\nThis isn't connected on your Composio dashboard yet. Type "yes" to connect ${found?.name || error.toolkit}, or "no" to skip.`
                };
                return updated;
              });
              continue;
            }

            // Other structured error types: TOOL_NOT_FOUND, MISSING_REQUIRED_PARAMS,
            // RATE_LIMITED, INVALID_PARAMS, NOT_CONFIGURED, EXECUTION_FAILED, ...
            const errorMsg = error?.message || error || 'Unknown error';
            const suggestion = error?.suggestion ? `\n${error.suggestion}` : '';
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: `${toolName} failed: ${errorMsg}${suggestion}` };
              return updated;
            });
          } catch (e) {
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: `Tool execution error: ${e.message}` };
              return updated;
            });
          }
        }
      }
    }
  }

  async function handleMicClick() {
    if (listening) return;
    stopSpeaking();
    try {
      const transcript = await listen();
      if (transcript) sendMessage(transcript);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (e.name === 'NonSpeechCaptionError') return;
      setError(e.message || 'Microphone error.');
    }
  }

  function handleSendVoice() {
    sendVoice();
  }

  function handleCancelRecording() {
    cancelRecording();
  }

  async function handleCopyMessage(content, msgId) {
    try {
      if (api?.clipboard) {
        await api.clipboard.writeText(content);
      } else {
        await navigator.clipboard.writeText(content);
      }
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }

  function resizeComposerInput() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  useEffect(() => {
    resizeComposerInput();
  }, [input]);

  const filteredCommands = showCmds
    ? COMMANDS.filter(c => c.cmd.startsWith(cmdFilter.toLowerCase()))
    : [];

  function selectCommand(cmd) {
    setInput(cmd + ' ');
    setShowCmds(false);
    setCmdFilter('');
    setCmdIdx(0);
    inputRef.current?.focus();
  }

  function handleInputChange(e) {
    const val = e.target.value;
    setInput(val);
    const firstLine = val.split('\n')[0];
    if (firstLine.startsWith('/') && !firstLine.includes(' ')) {
      setCmdFilter(firstLine);
      setShowCmds(true);
      setCmdIdx(0);
    } else {
      setShowCmds(false);
    }
  }

  function handleComposerPaste(e) {
    const pastedText = e.clipboardData?.getData('text/plain');
    if (!pastedText) return;

    e.preventDefault();
    const textarea = e.currentTarget;
    const start = textarea.selectionStart ?? input.length;
    const end = textarea.selectionEnd ?? input.length;
    const normalizedText = pastedText.replace(/\r\n?/g, '\n');
    const nextValue = input.slice(0, start) + normalizedText + input.slice(end);
    const cursor = start + normalizedText.length;

    setInput(nextValue);
    requestAnimationFrame(() => {
      textarea.selectionStart = cursor;
      textarea.selectionEnd = cursor;
      resizeComposerInput();
    });
  }

  function handleInputKeyDown(e) {
    if (showCmds && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmdIdx(i => (i + 1) % filteredCommands.length);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdIdx(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectCommand(filteredCommands[cmdIdx].cmd);
        return;
      } else if (e.key === 'Escape') {
        setShowCmds(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && selectedModel && !isThinking) {
        sendMessage(input);
      }
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
    setIsThinking(false);
    clearQueue();
  }

  return (
    <div className="app">
      {/* Sidebar */}
      <div className={`sidebar ${showSidebar ? 'open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Conversations</span>
          <button className="sidebar-close" onClick={() => setShowSidebar(false)}>✕</button>
        </div>
        <button className="new-chat-btn" onClick={createNewSession}>
          <span className="plus-icon">+</span> New Chat
        </button>
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="no-sessions">No conversations yet</div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
              onClick={() => loadSession(s.id)}
            >
              <div className="session-info">
                <div className="session-name">{s.title}</div>
                <div className="session-meta">{formatTime(s.updatedAt)}</div>
              </div>
              <div className="session-actions">
                <button className="session-btn rename" onClick={(e) => renameSession(s.id, e)} title="Rename">✎</button>
                <button className="session-btn delete" onClick={(e) => deleteSession(s.id, e)} title="Delete">🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {showSidebar && <div className="sidebar-overlay" onClick={() => setShowSidebar(false)} />}

      {/* Main */}
      <header className="topbar glass">
        <div className="brand">
          <button className="menu-btn" onClick={() => setShowSidebar(true)}>☰</button>
          <span className="dot" />
          Bob
        </div>
        <button className="settings-btn" onClick={() => setShowSettings(!showSettings)} title="Settings">
          ⚙
        </button>
      </header>

      {/* Settings Panel */}
      {showSettings && (
        <div className="settings-panel glass">
          <div className="settings-tabs">
            <button className={`settings-tab ${settingsTab === 'general' ? 'active' : ''}`} onClick={() => setSettingsTab('general')}>General</button>
            <button className={`settings-tab ${settingsTab === 'connectors' ? 'active' : ''}`} onClick={() => { setSettingsTab('connectors'); fetchConnectors(); }}>Connectors</button>
          </div>

          {settingsTab === 'general' && (
            <>
              <div className="settings-row">
                <label>Model</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {models.length === 0 && <option value="">No models</option>}
                  {models.length > 0 && !selectedModel && <option value="">Select a model</option>}
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <label>Auto Speak</label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={autoSpeak}
                    onChange={(e) => setAutoSpeak(e.target.checked)}
                  />
                  <span className="toggle-label">Speak replies</span>
                </label>
              </div>
              <div className="settings-divider" />
              <div className="settings-row">
                <button className="settings-voice-btn" onClick={openVoicePanel}>
                  Voice Settings
                </button>
              </div>
            </>
          )}

          {settingsTab === 'connectors' && (
            <div className="connectors-panel">
              <div className="connectors-search">
                <input
                  type="text"
                  placeholder="Search connectors..."
                  value={connectorFilter}
                  onChange={(e) => setConnectorFilter(e.target.value)}
                />
              </div>
              <div className="connectors-tabs">
                <button className={`connector-tab ${connectorTab === 'all' ? 'active' : ''}`} onClick={() => setConnectorTab('all')}>All</button>
                <button className={`connector-tab ${connectorTab === 'connected' ? 'active' : ''}`} onClick={() => setConnectorTab('connected')}>Connected</button>
                <button className={`connector-tab ${connectorTab === 'available' ? 'active' : ''}`} onClick={() => setConnectorTab('available')}>Available</button>
              </div>
              {connectorsLoading ? (
                <div className="connectors-loading">Loading connectors...</div>
              ) : (
                <div className="connectors-grid">
                  {connectors
                    .filter(c => {
                      if (connectorFilter && !c.name.toLowerCase().includes(connectorFilter.toLowerCase()) && !c.slug.includes(connectorFilter.toLowerCase())) return false;
                      if (connectorTab === 'connected' && !c.connected) return false;
                      if (connectorTab === 'available' && c.connected) return false;
                      return true;
                    })
                    .map(c => (
                      <div key={c.slug} className={`connector-card ${c.connected ? 'connected' : ''}`}>
                        <div className="connector-icon">
                          {c.logo ? <img src={c.logo} alt={c.name} /> : getConnectorIcon(c.slug)}
                        </div>
                        <div className="connector-info">
                          <div className="connector-name">{c.name}</div>
                          <div className="connector-desc">{c.description || c.slug}</div>
                        </div>
                        <button
                          className={`connector-btn ${c.connected ? 'connected' : ''}`}
                          onClick={() => !c.connected && handleConnectToolkit(c.slug)}
                        >
                          {c.connected ? 'Connected' : '+'}
                        </button>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Voice Settings Panel */}
      {showVoicePanel && (
        <div className="voice-panel glass">
          <div className="voice-tabs">
            <button
              className={`voice-tab ${tempTtsProvider === 'system' ? 'active' : ''}`}
              onClick={() => setTempTtsProvider('system')}
            >
              System Voice
            </button>
            <button
              className={`voice-tab ${tempTtsProvider === 'edge' ? 'active' : ''}`}
              onClick={() => setTempTtsProvider('edge')}
            >
              Edge TTS
            </button>
          </div>

          {tempTtsProvider === 'system' ? (
            <>
              <div className="voice-row">
                <label>Voice</label>
                <select
                  value={tempSystemVoice?.name || ''}
                  onChange={(e) => setTempSystemVoice(systemVoices.find(v => v.name === e.target.value))}
                >
                  {systemVoices.length === 0 && <option value="">No voices</option>}
                  {systemVoices.map((v) => (
                    <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                  ))}
                </select>
              </div>
              <div className="voice-row">
                <label>Speed: {tempRate.toFixed(1)}x</label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={tempRate}
                  onChange={(e) => setTempRate(parseFloat(e.target.value))}
                />
              </div>
              <div className="voice-row">
                <label>Pitch: {tempPitch.toFixed(1)}</label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={tempPitch}
                  onChange={(e) => setTempPitch(parseFloat(e.target.value))}
                />
              </div>
            </>
          ) : (
            <>
              <div className="voice-row">
                <label>Voice</label>
                {edgeVoicesLoading ? (
                  <div className="voice-loading">
                    <span>Loading voices...</span>
                  </div>
                ) : edgeVoicesError ? (
                  <div className="voice-loading">
                    <span className="voice-error">{edgeVoicesError}</span>
                    <button onClick={refreshEdgeVoices} className="voice-retry">Retry</button>
                  </div>
                ) : edgeVoices.length === 0 ? (
                  <div className="voice-loading">
                    <span>No voices found</span>
                    <button onClick={refreshEdgeVoices} className="voice-retry">Retry</button>
                  </div>
                ) : (
                  <select
                    value={tempEdgeVoice}
                    onChange={(e) => setTempEdgeVoice(e.target.value)}
                  >
                    {edgeVoices.map((v) => (
                      <option key={v.ShortName} value={v.ShortName}>
                        {v.FriendlyName} ({v.Locale})
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="voice-row">
                <label>Speed: {tempEdgeRate >= 0 ? '+' : ''}{tempEdgeRate}%</label>
                <input
                  type="range"
                  min="-50"
                  max="100"
                  step="5"
                  value={tempEdgeRate}
                  onChange={(e) => setTempEdgeRate(parseInt(e.target.value))}
                />
              </div>
              <div className="voice-row">
                <label>Pitch: {tempEdgePitch >= 0 ? '+' : ''}{tempEdgePitch}Hz</label>
                <input
                  type="range"
                  min="-50"
                  max="50"
                  step="5"
                  value={tempEdgePitch}
                  onChange={(e) => setTempEdgePitch(parseInt(e.target.value))}
                />
              </div>
              <div className="voice-badge">Neural voices — sounds more natural</div>
            </>
          )}

          <div className="voice-actions">
            <button onClick={cancelVoiceSettings} className="voice-cancel">Cancel</button>
            <button onClick={applyVoiceSettings} className="voice-apply">Apply</button>
          </div>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {status && !error && <div className="banner status">{status}</div>}
      {pullProgress && <div className="banner progress">{pullProgress}</div>}
      {showLoadPrompt && (
        <div className="banner prompt">
          <span>No model loaded. Load <strong>{DEFAULT_MODEL}</strong>?</span>
          <div className="prompt-actions">
            <button onClick={loadDefaultModel} className="prompt-yes">Yes, load it</button>
            <button onClick={cancelLoadModel} className="prompt-no">No thanks</button>
          </div>
        </div>
      )}
      {!voiceSupported && (
        <div className="banner warn">Voice input isn't supported in this build, but typing still works.</div>
      )}

      <main className="chat" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <div className="role">{m.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="content">{(m.role === 'assistant' ? stripToolCalls(stripHtml(m.content)) : m.content) || (isThinking && i === messages.length - 1 ? '…' : '')}</div>
            {m.role === 'assistant' && m.content && (
              <button
                className={`copy-btn ${copiedMsgId === i ? 'copied' : ''}`}
                onClick={() => handleCopyMessage(m.content, i)}
                title={copiedMsgId === i ? 'Copied!' : 'Copy message'}
              >
                {copiedMsgId === i ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy
                  </>
                )}
              </button>
            )}
          </div>
        ))}
      </main>

      <div className="composer-wrapper">
        {showCmds && filteredCommands.length > 0 && (
          <div className="cmd-dropdown glass">
            {filteredCommands.map((c, i) => (
              <div
                key={c.cmd}
                className={`cmd-item ${i === cmdIdx ? 'active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); selectCommand(c.cmd); }}
                onMouseEnter={() => setCmdIdx(i)}
              >
                <span className="cmd-name">{c.cmd}</span>
                <span className="cmd-desc">{c.desc}</span>
              </div>
            ))}
          </div>
        )}
        <form className="composer glass" onSubmit={handleSubmit}>
          {listening ? (
            <>
              <button type="button" className="stop" onClick={handleCancelRecording} title="Cancel recording">✕</button>
              <input
                type="text"
                value=""
                placeholder="Listening..."
                disabled
                className="listening-input"
              />
              <button type="button" className="send-voice" onClick={handleSendVoice} title="Send voice">➤</button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`mic ${transcribing ? 'transcribing' : ''}`}
                onClick={handleMicClick}
                disabled={!voiceSupported || !selectedModel || transcribing}
                title={!voiceSupported ? 'Voice not supported' : transcribing ? 'Transcribing...' : 'Click to talk'}
              >
                {transcribing ? '⏳' : '🎤'}
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onPaste={handleComposerPaste}
                onKeyDown={handleInputKeyDown}
                rows={1}
                placeholder={selectedModel ? 'Type a message… (try / for commands)' : 'Load a model first'}
                disabled={!selectedModel}
                title="Press Shift+Enter for a new line"
              />
              {speaking && (
                <button type="button" className="stop" onClick={stopSpeaking} title="Stop speaking">■</button>
              )}
              {speaking ? (
                <button type="submit" disabled={!input.trim() || !selectedModel} title="Send message">➤</button>
              ) : isThinking ? (
                <button type="button" className="stop" onClick={stopGenerating} title="Stop generating">■</button>
              ) : (
                <button type="submit" disabled={!input.trim() || !selectedModel} title="Send message">➤</button>
              )}
            </>
          )}
        </form>
      </div>
    </div>
  );
}
