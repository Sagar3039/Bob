const { app, BrowserWindow, Menu, ipcMain, globalShortcut, screen, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load COMPOSIO_API_KEY (and any other secrets) from a local .env file.
// This file is gitignored — never commit real keys to the repo.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const composio = require('./composio');

const isDev = process.env.NODE_ENV === 'development';
const DEFAULT_TOOLKITS = ['github', 'gmail', 'googlesuper', 'notion', 'linkedin'];
let cachedToolkitSummary = null;
let cachedToolkitSummaryTime = 0;

const SESSIONS_FILE = path.join(app.getPath('userData'), 'sessions.json');
const MEMORY_FILE = path.join(app.getPath('userData'), 'memory.json');

const VOICE_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const WSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
};

let EdgeTTS = null;

async function getEdgeTTS() {
  if (!EdgeTTS) {
    const mod = await import('node-edge-tts');
    EdgeTTS = mod.EdgeTTS;
  }
  return EdgeTTS;
}

function readSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function writeSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

// ─── Memory System ──────────────────────────────────────────────────
const DEFAULT_MEMORY = { facts: [], explicit_memories: [], stories: [], goals: [], preferences: [], key_topics: [], extracted_sessions: [] };

function readMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch {}
  return { ...DEFAULT_MEMORY };
}

function writeMemory(memory) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf-8');
}

const OLLAMA_BASE = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma4:31b-cloud';

const SYSTEM_PROMPT = `You are Bob — Sagar's closest friend and thinking partner. You run locally on his machine via Ollama (gemma4:31b-cloud), with external tool access via Composio.

## Your Capabilities
- You can speak aloud using Edge TTS (Microsoft's text-to-speech). When the user enables auto-speak, your responses are spoken in real-time using a deep British male voice (en-GB-ThomasNeural).
- You can listen: the user can speak to you via microphone. You receive their speech as text (converted by Whisper STT).
- You remember things across conversations. Past conversations are stored and you can recall facts, stories, goals, and preferences from them. When the user asks "what did we talk about before" or references a past topic, you have access to that context.
- You have external tool access via Composio — including GitHub, Gmail, Google Tasks, Google Drive, Google Calendar, Notion, and LinkedIn, plus any additional service Composio supports if the user asks for it and confirms connecting it. When you need to use a tool, respond with [TOOL_CALL: TOOL_NAME({...})] and the system will execute it for you. (The full, current tool list and rules are appended below this prompt at runtime.)
- If the user asks for a service that isn't already connected, don't say you can't help — use [TOOL_CALL: DISCOVER_TOOLKIT({"query": "..."})] to search Composio's catalog, then ask for confirmation before connecting anything.
- You run locally via Ollama for your brain, but your tool access (Composio) connects to cloud services when needed. Edge TTS powers your voice, Whisper powers your ears.

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

## Local Automation Capabilities
You have full local system access. You can:

1. WRITE FILES to disk using FILE_WRITE. Use this to create Python scripts, batch files, config files, etc. Always use full Windows paths (C:\\Users\\<name>\\...).

2. EXECUTE SHELL COMMANDS using SHELL_EXEC. Use this to run Python scripts, check installed packages, install dependencies (pip install), verify services, etc.

3. CREATE SCHEDULED TASKS using SCHEDULE_TASK. This creates Windows Task Scheduler entries that run scripts on a schedule. Params: name, script_path, trigger_time (HH:MM), days (array: "monday" through "sunday").

IMPORTANT: User's home directory is C:\\Users\\Sagar Karmakar (with a space). Always use this exact path when writing files.
IMPORTANT: Python command is "py" NOT "python". Always use "py" to run Python scripts on this system.

When the user asks to automate something, write the complete working script first, explain what it does, then create the scheduled task if they want it recurring.

## Retry & Resilience Rules
When a tool call fails, do NOT give up immediately. Try up to 3 alternative approaches:

1. First failure: Try a different approach (e.g., if "python" fails, try "py"; if a path fails, try an alternative location; if a tool slug fails, try a similar one).
2. Second failure: Try a completely different method (e.g., if SHELL_EXEC fails, try writing a .bat file and running it; if FILE_WRITE fails to one path, try another).
3. Third failure: Only then report the failure to the user with a clear explanation of what went wrong and what they can do to fix it.

Examples of alternative strategies:
- Command not found: Try alternative command names (python -> py -> python3)
- Path rejected: Try different allowed paths (Desktop -> Documents -> Downloads)
- Tool not connected: Try discover + connect flow, or use a different tool
- API timeout: Retry with shorter timeout or smaller batch
- Permission denied: Try running with different flags or in a different directory

Never say "I can't" until you've exhausted all alternatives.

## Data Display Rules
- When presenting data from tools, ALWAYS format it as clean, readable text — never raw JSON.
- Show data as labeled fields with clear values (e.g., "Name: John", "Email: john@example.com").
- Only show raw JSON if the user specifically asks for it (e.g., "show me the JSON", "give me raw data").
- For lists, use numbered or bulleted format.
- Keep the data organized and easy to scan at a glance.
- If data is nested, flatten it into a readable hierarchy.`;

const STOPWORDS = new Set(['i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'hey', 'bob', 'hii', 'hiii', 'hiiii', 'yoo', 'yo', 'hello', 'hi', 'yes', 'no', 'yeah', 'ok', 'okay', 'lol', 'lmao', 'haha', 'hmm', 'um', 'uh', 'ah', 'oh']);

function extractKeywords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function extractMemoryFromSession(session) {
  const userMessages = session.messages.filter(m => m.role === 'user').map(m => m.content);
  const allText = userMessages.join(' ').toLowerCase();

  // Extract facts (numbers, scores, percentages)
  const facts = [];
  for (const msg of userMessages) {
    const percentMatch = msg.match(/(\d+)\s*%/g);
    if (percentMatch) {
      for (const p of percentMatch) {
        facts.push(`${msg.substring(0, 80).trim()} (mentioned ${p})`);
      }
    }
    const scoreMatch = msg.match(/(\d+)\s*(marks|score|scored|got)/i);
    if (scoreMatch) {
      facts.push(msg.substring(0, 100).trim());
    }
  }

  // Extract explicit memories ("remember", "don't forget", etc.)
  const explicit = [];
  for (const msg of userMessages) {
    if (/remember|don't forget|keep in mind|note that|important/i.test(msg)) {
      explicit.push(msg.substring(0, 150).trim());
    }
  }

  // Extract goals/decisions
  const goals = [];
  for (const msg of userMessages) {
    if (/want to|plan to|going to|goal is|decided to|i need to|i should|dream/i.test(msg)) {
      goals.push(msg.substring(0, 150).trim());
    }
  }

  // Extract preferences
  const prefs = [];
  for (const msg of userMessages) {
    if (/prefer|like|love|hate|favorite|best|worst/i.test(msg)) {
      prefs.push(msg.substring(0, 150).trim());
    }
  }

  // Detect stories (multi-turn exchanges with narrative content)
  const stories = [];
  const narrativeMarkers = /then|later|after that|finally|next|suddenly|meanwhile|3 days|next day|hours later|minutes later/i;
  let storyBuffer = [];
  let inStory = false;

  for (const msg of session.messages) {
    if (msg.role === 'user' && narrativeMarkers.test(msg.content)) {
      inStory = true;
    }
    if (inStory) {
      storyBuffer.push(msg);
    }
    if (inStory && storyBuffer.length >= 4) {
      const summary = storyBuffer.map(m => `${m.role}: ${m.content.substring(0, 80)}`).join(' | ');
      stories.push({
        title: session.title || 'Untitled Story',
        summary: summary.substring(0, 300),
        keywords: [...new Set(storyBuffer.flatMap(m => extractKeywords(m.content)))]
      });
      storyBuffer = [];
      inStory = false;
    }
  }

  // If we have a partial story buffer, still save it
  if (storyBuffer.length >= 2) {
    const summary = storyBuffer.map(m => `${m.role}: ${m.content.substring(0, 80)}`).join(' | ');
    stories.push({
      title: session.title || 'Untitled Story',
      summary: summary.substring(0, 300),
      keywords: [...new Set(storyBuffer.flatMap(m => extractKeywords(m.content)))]
    });
  }

  // Key topics for the session
  const allKeywords = extractKeywords(allText);
  const freq = {};
  for (const kw of allKeywords) { freq[kw] = (freq[kw] || 0) + 1; }
  const topTopics = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  const keyTopics = {
    sessionId: session.id,
    title: session.title || 'Untitled',
    date: new Date(session.updatedAt || session.createdAt).toISOString().split('T')[0],
    mainTopics: topTopics
  };

  return { facts, explicit, goals, prefs, stories, keyTopics };
}

function extractAndStoreMemory(session) {
  const memory = readMemory();

  // Skip if already extracted this session version
  const sessionVersion = `${session.id}_${session.updatedAt || session.createdAt}`;
  if (memory.extracted_sessions && memory.extracted_sessions.includes(sessionVersion)) {
    return memory;
  }

  const extracted = extractMemoryFromSession(session);

  // Merge facts (deduplicate)
  for (const f of extracted.facts) {
    if (!memory.facts.some(existing => existing.toLowerCase() === f.toLowerCase())) {
      memory.facts.push(f);
    }
  }

  // Merge explicit memories
  for (const e of extracted.explicit) {
    if (!memory.explicit_memories.some(existing => existing.toLowerCase() === e.toLowerCase())) {
      memory.explicit_memories.push(e);
    }
  }

  // Merge goals
  for (const g of extracted.goals) {
    if (!memory.goals.some(existing => existing.toLowerCase() === g.toLowerCase())) {
      memory.goals.push(g);
    }
  }

  // Merge preferences
  for (const p of extracted.prefs) {
    if (!memory.preferences.some(existing => existing.toLowerCase() === p.toLowerCase())) {
      memory.preferences.push(p);
    }
  }

  // Merge stories (by title to avoid duplicates)
  for (const s of extracted.stories) {
    if (!memory.stories.some(existing => existing.title === s.title)) {
      memory.stories.push(s);
    }
  }

  // Update key_topics
  const existingTopics = memory.key_topics.findIndex(t => t.sessionId === extracted.keyTopics.sessionId);
  if (existingTopics >= 0) {
    memory.key_topics[existingTopics] = extracted.keyTopics;
  } else {
    memory.key_topics.push(extracted.keyTopics);
  }

  // Track extracted sessions
  if (!memory.extracted_sessions) memory.extracted_sessions = [];
  memory.extracted_sessions.push(sessionVersion);

  // Cap memory size
  if (memory.facts.length > 100) memory.facts = memory.facts.slice(-80);
  if (memory.explicit_memories.length > 50) memory.explicit_memories = memory.explicit_memories.slice(-40);
  if (memory.goals.length > 50) memory.goals = memory.goals.slice(-40);
  if (memory.preferences.length > 50) memory.preferences = memory.preferences.slice(-40);
  if (memory.stories.length > 30) memory.stories = memory.stories.slice(-20);
  if (memory.key_topics.length > 50) memory.key_topics = memory.key_topics.slice(-40);

  writeMemory(memory);
  return memory;
}

function getMemoryContext(currentMessage, currentSessionId) {
  const memory = readMemory();
  const keywords = extractKeywords(currentMessage);
  const contextParts = [];

  // Always include facts
  if (memory.facts.length > 0) {
    contextParts.push('Facts about Sagar:\n' + memory.facts.slice(-15).map(f => `- ${f}`).join('\n'));
  }

  // Always include goals
  if (memory.goals.length > 0) {
    contextParts.push('Goals & Plans:\n' + memory.goals.slice(-10).map(g => `- ${g}`).join('\n'));
  }

  // Include explicit memories
  if (memory.explicit_memories.length > 0) {
    contextParts.push('Important notes:\n' + memory.explicit_memories.slice(-10).map(e => `- ${e}`).join('\n'));
  }

  // Keyword-matched stories
  const matchedStories = memory.stories.filter(s =>
    s.keywords.some(kw => keywords.includes(kw))
  );
  if (matchedStories.length > 0) {
    contextParts.push('Relevant stories from past conversations:\n' +
      matchedStories.slice(0, 3).map(s => `[${s.title}] ${s.summary}`).join('\n'));
  }

  // Keyword-matched conversation topics
  const matchedTopics = memory.key_topics.filter(t =>
    t.sessionId !== currentSessionId &&
    t.mainTopics.some(kw => keywords.includes(kw))
  );
  if (matchedTopics.length > 0) {
    contextParts.push('Related past conversations:\n' +
      matchedTopics.slice(0, 3).map(t => `- "${t.title}" (${t.date}): discussed ${t.mainTopics.join(', ')}`).join('\n'));
  }

  // If user asks about past conversations directly
  if (/last time|previous|before|earlier|before that|our last|past|remember/i.test(currentMessage)) {
    // Include ALL conversation summaries
    const allTopics = memory.key_topics
      .filter(t => t.sessionId !== currentSessionId)
      .slice(-10);
    if (allTopics.length > 0) {
      contextParts.push('All past conversations:\n' +
        allTopics.map(t => `- "${t.title}" (${t.date}): ${t.mainTopics.join(', ')}`).join('\n'));
    }
  }

  const fullContext = contextParts.join('\n\n');
  // Cap at ~2000 chars to avoid hitting context limits
  return fullContext.length > 2000 ? fullContext.substring(0, 2000) + '...' : fullContext;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });
}

// ─── Spotlight Popup ────────────────────────────────────────────────
let popupWin = null;

function createPopup() {
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.focus();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  popupWin = new BrowserWindow({
    width: 680,
    height: 90,
    x: Math.round((screenW - 680) / 2),
    y: Math.round((screenH - 200) / 2),
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'popup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  popupWin.loadFile(path.join(__dirname, 'popup.html'));

  popupWin.once('ready-to-show', () => {
    popupWin.show();
    popupWin.focus();
  });

  popupWin.on('closed', () => {
    popupWin = null;
  });
}

function togglePopup() {
  if (popupWin && !popupWin.isDestroyed()) {
    if (popupWin.isVisible()) {
      popupWin.hide();
    } else {
      popupWin.show();
      popupWin.focus();
    }
  } else {
    createPopup();
  }
}

ipcMain.on('popup:hide', () => {
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.hide();
  }
});

// Session IPC handlers
ipcMain.handle('sessions:load', () => readSessions());
ipcMain.handle('sessions:save', (_, sessions) => {
  writeSessions(sessions);
  return true;
});

// Clipboard
ipcMain.handle('clipboard:writeText', (_, text) => {
  clipboard.writeText(text);
  return true;
});

// Memory IPC handlers
ipcMain.handle('memory:load', () => readMemory());
ipcMain.handle('memory:save', (_, memory) => {
  writeMemory(memory);
  return true;
});
ipcMain.handle('memory:extract', (_, session) => {
  return extractAndStoreMemory(session);
});
ipcMain.handle('memory:getContext', (_, currentMessage, currentSessionId) => {
  return getMemoryContext(currentMessage, currentSessionId);
});

// Edge TTS IPC handlers
let cachedVoices = null;

ipcMain.handle('tts:getEdgeVoices', async () => {
  try {
    if (cachedVoices && cachedVoices.length > 0) return cachedVoices;

    console.log('Fetching Edge TTS voices...');
    const response = await fetch(VOICE_LIST_URL, { headers: WSS_HEADERS });

    if (!response.ok) {
      console.error('Failed to fetch voices:', response.status);
      return [];
    }

    const voices = await response.json();
    console.log('Edge TTS voices fetched:', voices?.length);
    cachedVoices = Array.isArray(voices) ? voices : [];
    return cachedVoices;
  } catch (e) {
    console.error('Failed to get Edge voices:', e.message);
    return [];
  }
});

ipcMain.handle('tts:speak', async (_, text, options = {}) => {
  const tmpFile = path.join(app.getPath('temp'), `tts_${Date.now()}.mp3`);

  try {
    console.log('Edge TTS speaking:', text.substring(0, 50), options);

    const EdgeTTSService = await getEdgeTTS();

    const tts = new EdgeTTSService({
      voice: options.voice || 'en-GB-ThomasNeural',
      lang: options.voice?.split('-').slice(0, 2).join('-') || 'en-GB',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: options.rate || 'default',
      pitch: options.pitch || 'default',
      volume: options.volume || 'default',
      timeout: 30000
    });

    await tts.ttsPromise(text, tmpFile);

    const audioBuffer = fs.readFileSync(tmpFile);
    console.log('Edge TTS audio size:', audioBuffer.length);

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}

    return audioBuffer.toString('base64');
  } catch (e) {
    console.error('Edge TTS error:', e.message);
    // Clean up temp file on error
    try { fs.unlinkSync(tmpFile); } catch {}
    throw e;
  }
});

ipcMain.handle('tts:stop', async () => {
  return true;
});

// ─── Popup Chat (streams via webContents.send) ──────────────────────
ipcMain.handle('popup:chat', async (event, query, model) => {
  const webContents = event.sender;
  const usedModel = model || DEFAULT_MODEL;

  let memoryContext = '';
  try {
    memoryContext = getMemoryContext(query, 'popup');
  } catch {}

  // Get Composio tools (lightweight — service names only). Single source of
  // truth lives in composio.js so this can never drift out of sync with the
  // real tool list, execution rules, or the discovery/connect flow.
  let toolPrompt = '';
  try {
    if (!cachedToolkitSummary || (Date.now() - cachedToolkitSummaryTime > 5 * 60 * 1000)) {
      cachedToolkitSummary = await composio.getToolkitSummary();
      cachedToolkitSummaryTime = Date.now();
    }
    const summary = cachedToolkitSummary && cachedToolkitSummary.length > 0
      ? cachedToolkitSummary
      : DEFAULT_TOOLKITS.map(tk => ({ toolkit: tk }));
    toolPrompt = composio.buildToolPrompt(summary.map(s => ({ toolkit: s.name || s.toolkit, toolCount: s.toolCount })));
  } catch (e) {
    console.error('[Composio] Failed to build tool prompt:', e.message);
  }

  const basePrompt = SYSTEM_PROMPT;
  const now = new Date();
  const currentDateTime = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeBlock = `\n\n## Current Date and Time\nThe current date and time is: ${currentDateTime}\nTimezone: ${timezone}\nUse this to reference "today", "tomorrow", "yesterday", schedule posts, set due dates, and answer any time-related questions. Always use the user's timezone.`;

  const fullPrompt = [
    memoryContext ? `Here is what I remember from past conversations:\n${memoryContext}\n\nNow respond as Bob with this context available.\n\n${basePrompt}` : basePrompt,
    timeBlock,
    toolPrompt
  ].filter(Boolean).join('\n\n');

  const messages = [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: query }
  ];

  let fullResponse = '';

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: usedModel, messages, stream: true })
    });

    if (!res.ok || !res.body) {
      webContents.send('popup:chunk', { error: `Ollama request failed (${res.status})` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullResponse += json.message.content;
            webContents.send('popup:chunk', { text: json.message.content });
          }
          if (json.done) {
            webContents.send('popup:chunk', { done: true });
          }
        } catch {}
      }
    }

    // Check for tool call(s) in the response (there can be more than one)
    const toolCalls = composio.parseToolCalls(fullResponse);
    for (const toolCall of toolCalls) {
      webContents.send('popup:chunk', { toolCall: toolCall.toolName });
      const result = await composio.executeTool(toolCall.toolName, toolCall.args);
      
      if (result.success) {
        // CONNECT_TOOLKIT succeeded in starting authorization — open the browser.
        if (toolCall.toolName === 'CONNECT_TOOLKIT' && result.result?.authUrl) {
          shell.openExternal(result.result.authUrl);
        }
        webContents.send('popup:chunk', {
          toolResult: {
            name: toolCall.toolName,
            success: true,
            // LIST_TOOLKIT_TOOLS returns a formatted, human-readable listing.
            data: (toolCall.toolName === 'LIST_TOOLKIT_TOOLS' && result.result?.tools)
              ? result.result.tools
              : result.result
          }
        });
        continue;
      }

      const error = result.error;

      // NOT_CONNECTED: a real toolkit exists but the user's account isn't
      // authorized yet. Open the browser immediately — Composio's OAuth
      // screen itself is the user's confirmation step here.
      if (error && error.type === 'NOT_CONNECTED') {
        webContents.send('popup:chunk', {
          toolResult: { name: toolCall.toolName, success: false, data: `${error.suggestion}\n\nOpening authorization page...` }
        });
        try {
          const { url } = await composio.startConnect(error.toolkit);
          if (url) shell.openExternal(url);
          webContents.send('popup:chunk', {
            toolResult: { name: toolCall.toolName, success: false, data: `Authorization page opened. Please complete authorization, then ask me to retry.` }
          });
        } catch (connectErr) {
          webContents.send('popup:chunk', {
            toolResult: { name: toolCall.toolName, success: false, data: `Failed to start connection: ${connectErr.message}` }
          });
        }
        continue;
      }

      // TOOLKIT_FOUND_NEEDS_CONFIRMATION: DISCOVER_TOOLKIT found a service
      // that isn't in Sagar's Composio dashboard/default set yet. We do NOT
      // auto-connect — surface it and wait for an explicit confirmation turn
      // before CONNECT_TOOLKIT is ever called.
      if (error && error.type === 'TOOLKIT_FOUND_NEEDS_CONFIRMATION') {
        webContents.send('popup:chunk', {
          toolResult: {
            name: toolCall.toolName,
            success: false,
            data: `${error.message} ${error.suggestion}`,
            needsConfirmation: true,
            discovered: error.discovered
          }
        });
        continue;
      }

      // CONNECT_TOOLKIT failed — surface the reason directly.
      if (toolCall.toolName === 'CONNECT_TOOLKIT' && error) {
        webContents.send('popup:chunk', {
          toolResult: { name: toolCall.toolName, success: false, data: `${error.message} ${error.suggestion || ''}` }
        });
        continue;
      }

      // Every other structured error type (TOOL_NOT_FOUND, MISSING_REQUIRED_PARAMS,
      // RATE_LIMITED, INVALID_PARAMS, NOT_CONFIGURED, EXECUTION_FAILED, ...)
      webContents.send('popup:chunk', {
        toolResult: {
          name: toolCall.toolName,
          success: false,
          data: error?.suggestion ? `${error.message} ${error.suggestion}` : (error?.message || error || 'Unknown error')
        }
      });
    }
  } catch (e) {
    webContents.send('popup:chunk', { error: e.message });
  }
});

ipcMain.handle('popup:resize', async (event, height) => {
  if (popupWin && !popupWin.isDestroyed()) {
    const currentBounds = popupWin.getBounds();
    const screen = require('electron').screen;
    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const newY = Math.round((screenH - height) / 2);
    popupWin.setBounds({
      x: currentBounds.x,
      y: newY,
      width: currentBounds.width,
      height: height
    });
  }
});

ipcMain.handle('popup:tts', async (_, text) => {
  const tmpFile = path.join(app.getPath('temp'), `popup_tts_${Date.now()}.mp3`);
  try {
    const EdgeTTSService = await getEdgeTTS();
    const tts = new EdgeTTSService({
      voice: 'en-GB-ThomasNeural',
      lang: 'en-GB',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      rate: 'default',
      pitch: 'default',
      volume: 'default',
      timeout: 30000
    });
    await tts.ttsPromise(text, tmpFile);
    const audioBuffer = fs.readFileSync(tmpFile);
    try { fs.unlinkSync(tmpFile); } catch {}
    return audioBuffer.toString('base64');
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    throw e;
  }
});

ipcMain.handle('popup:getModel', async () => {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`);
    if (res.ok) {
      const data = await res.json();
      const models = data.models || [];
      if (models.length > 0) return models[0].name;
    }
  } catch {}
  return DEFAULT_MODEL;
});

// ─── Composio IPC handlers ──────────────────────────────────────────
ipcMain.handle('composio:getTools', async (_, toolkits) => {
  return await composio.getToolsForPrompt(toolkits);
});

ipcMain.handle('composio:buildPrompt', async () => {
  // Delegates to composio.js so this always matches the real tool list,
  // validation rules, and the discovery/connect flow — no drift between
  // three copies of the same instructions.
  if (!cachedToolkitSummary || (Date.now() - cachedToolkitSummaryTime > 5 * 60 * 1000)) {
    try {
      cachedToolkitSummary = await composio.getToolkitSummary();
      cachedToolkitSummaryTime = Date.now();
    } catch (e) {
      console.error('[Composio] Failed to refresh toolkit summary:', e.message);
    }
  }
  const summary = cachedToolkitSummary && cachedToolkitSummary.length > 0
    ? cachedToolkitSummary
    : DEFAULT_TOOLKITS.map(tk => ({ toolkit: tk }));
  return composio.buildToolPrompt(summary.map(s => ({ toolkit: s.name || s.toolkit, toolCount: s.toolCount })));
});

ipcMain.handle('composio:execute', async (_, toolName, args) => {
  return await composio.executeTool(toolName, args);
});

ipcMain.handle('composio:connectUrl', async (_, toolkit) => {
  return await composio.getConnectUrl(toolkit);
});

ipcMain.handle('composio:status', async (_, toolkit) => {
  return await composio.getConnectionStatus(toolkit);
});

ipcMain.handle('composio:isConnected', async (_, toolkit) => {
  return await composio.isConnected(toolkit);
});

ipcMain.handle('composio:startConnect', async (_, toolkit) => {
  const result = await composio.startConnect(toolkit);
  if (result.url) {
    shell.openExternal(result.url);
  }
  return result;
});

ipcMain.handle('composio:waitForConnection', async (_, toolkit, timeoutMs) => {
  return await composio.waitForConnection(toolkit, timeoutMs);
});

ipcMain.handle('composio:toolkitSummary', async () => {
  return await composio.getToolkitSummary();
});

ipcMain.handle('composio:toolkitDetail', async (_, toolkit) => {
  const tools = await composio.getToolsForToolkit(toolkit);
  return composio.buildToolkitDetailPrompt(tools, toolkit);
});

ipcMain.handle('composio:isConfigured', async () => {
  return composio.isConfigured();
});

// Explicit discovery/connect handlers for a UI confirmation dialog (in
// addition to the in-chat [TOOL_CALL: DISCOVER_TOOLKIT(...)] flow). Neither
// of these ever connects anything without the renderer calling connectToolkit
// as a separate, deliberate step after the user confirms.
ipcMain.handle('composio:discoverToolkit', async (_, query) => {
  return await composio.discoverToolkit(query);
});

ipcMain.handle('composio:connectToolkit', async (_, toolkit) => {
  const result = await composio.connectDiscoveredToolkit(toolkit);
  if (result.url) {
    shell.openExternal(result.url);
  }
  return result;
});

// Get all toolkits with connection status for the Connectors panel
ipcMain.handle('composio:allConnectors', async () => {
  try {
    const [catalog, connectedSlugs] = await Promise.all([
      composio.getFullCatalog(),
      composio.getConnectedToolkitSlugs()
    ]);
    return catalog.map(tk => {
      const slug = (tk.slug || tk.name || '').toLowerCase();
      return {
        slug,
        name: tk.name || slug,
        description: tk.description || tk.meta?.description || '',
        connected: connectedSlugs.has(slug),
        toolCount: tk.toolCount || tk.meta?.toolsCount || 0,
        logo: tk.meta?.logo || ''
      };
    });
  } catch (e) {
    console.error('[Composio] Failed to fetch all connectors:', e.message);
    return [];
  }
});

// ─── Whisper STT (runs in main process) ─────────────────────────────
let whisperPipeline = null;

function parseWavToFloat32(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV audio received.');
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        numChannels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14)
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset < 0) {
    throw new Error('WAV audio is missing required fmt or data chunks.');
  }

  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format: ${bitsPerSample}-bit format ${audioFormat}.`);
  }

  const bytesPerSample = bitsPerSample / 8;

  const pcmData = buffer.slice(dataOffset, Math.min(buffer.length, dataOffset + dataSize));
  const numSamples = Math.floor(pcmData.length / (numChannels * bytesPerSample));
  if (numSamples === 0) {
    throw new Error('No audio samples were recorded.');
  }
  const float32 = new Float32Array(numSamples);
  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < numSamples; i++) {
    const offset = i * numChannels * bytesPerSample;
    // Mix down to mono if stereo
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      const sampleOffset = offset + c * bytesPerSample;
      const sample = pcmData.readInt16LE(sampleOffset);
      sum += sample / 32768.0;
    }
    float32[i] = sum / numChannels;
    const abs = Math.abs(float32[i]);
    if (abs > peak) peak = abs;
    sumSquares += float32[i] * float32[i];
  }

  const duration = numSamples / sampleRate;
  const rms = Math.sqrt(sumSquares / numSamples);

  return { audio: float32, sampleRate, duration, peak, rms };
}

function normalizeTranscript(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function isLikelyWhisperCaption(text) {
  const normalized = normalizeTranscript(text).toLowerCase();
  if (!normalized) return true;

  const captionPattern = /^\[([^\]]+)\]$/;
  const match = normalized.match(captionPattern);
  if (!match) return false;

  const caption = match[1].trim();
  const nonSpeechCaptions = new Set([
    'applause', 'breathing', 'clapping', 'gunfire', 'laughter', 'laughs',
    'music', 'noise', 'silence', 'sound', 'static', 'typing'
  ]);

  return nonSpeechCaptions.has(caption) || !/[a-z0-9]/i.test(caption);
}

function shouldRejectTranscript(text, audioStats) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return 'No speech recognized.';
  if (isLikelyWhisperCaption(normalized)) return `Ignored non-speech caption: ${normalized}`;

  // Very quiet recordings make Whisper more likely to hallucinate a plausible
  // caption or phrase. Keep the threshold conservative so soft real speech
  // still gets through.
  if (audioStats.rms < 0.0015 && normalized.length < 20) {
    return 'Recording level was too low to transcribe reliably.';
  }

  return '';
}

ipcMain.handle('stt:transcribe', async (_, audioBase64) => {
  try {
    if (!whisperPipeline) {
      console.log('[STT] Loading Whisper model...');
      const { pipeline } = await import('@xenova/transformers');
      whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        language: 'en',
        task: 'transcribe'
      });
      console.log('[STT] Whisper model loaded.');
    }

    // Decode base64 WAV audio
    const wavBuffer = Buffer.from(audioBase64, 'base64');
    const { audio, sampleRate, duration, peak, rms } = parseWavToFloat32(wavBuffer);

    console.log('[STT] Audio length:', audio.length, 'samples at', sampleRate, 'Hz', {
      duration: duration.toFixed(2),
      peak: peak.toFixed(4),
      rms: rms.toFixed(4)
    });
    // Pass raw Float32Array directly to the pipeline.
    const result = await whisperPipeline(audio, {
      language: 'en',
      task: 'transcribe',
      chunk_length_s: 15,
      stride_length_s: 2
    });

    const text = normalizeTranscript(result?.text);
    const rejectedReason = shouldRejectTranscript(text, { duration, peak, rms });
    if (rejectedReason) {
      console.warn('[STT] Rejected transcript:', rejectedReason);
      return { text: '', rejectedReason };
    }

    return { text };
  } catch (e) {
    console.error('[STT] Transcription error:', e.message);
    throw e;
  }
});

// ─── File System Operations ────────────────────────────────────────
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Allowed base directories for file operations (security)
const FS_ROOTS = [
  app.getPath('home'),
  app.getPath('desktop'),
  app.getPath('documents'),
  app.getPath('downloads'),
  path.join(app.getPath('home'), 'Desktop'),
  path.join(app.getPath('home'), 'Documents'),
  path.join(app.getPath('home'), 'Downloads'),
];

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  return FS_ROOTS.some(root => resolved.startsWith(path.resolve(root)));
}

ipcMain.handle('fs:writeFile', async (_, { filePath, content }) => {
  try {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path not allowed. Can only write to Home, Desktop, Documents, or Downloads.' };
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // For .py files, escape backslashes so Python doesn't interpret \U, \S etc as unicode escapes
    const writeContent = filePath.endsWith('.py') ? content.replace(/\\/g, '\\\\') : content;
    fs.writeFileSync(filePath, writeContent, 'utf-8');
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:readFile', async (_, { filePath }) => {
  try {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path not allowed.' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:listDir', async (_, { dirPath }) => {
  try {
    if (!isPathAllowed(dirPath)) {
      return { success: false, error: 'Path not allowed.' };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return {
      success: true,
      entries: entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: path.join(dirPath, e.name)
      }))
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── Shell Execution ───────────────────────────────────────────────
ipcMain.handle('shell:exec', async (_, { command, cwd, timeout }) => {
  try {
    const maxTimeout = Math.min(timeout || 30000, 120000);
    const workDir = cwd && isPathAllowed(cwd) ? cwd : app.getPath('home');
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const { stdout, stderr } = await execFileAsync('powershell', ['-NoProfile', '-EncodedCommand', encodedCommand], {
      cwd: workDir,
      timeout: maxTimeout,
      maxBuffer: 1024 * 1024
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { success: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
});

// ─── Windows Task Scheduler ────────────────────────────────────────
ipcMain.handle('scheduler:createTask', async (_, { name, scriptPath, triggerTime, daysOfWeek }) => {
  try {
    const taskName = `Bob_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const schedule = triggerTime || '08:00';
    const [hour, minute] = schedule.split(':');

    // Build the schtasks XML
    const dayMap = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
    const days = (daysOfWeek || ['fri']).map(d => dayMap[d.toLowerCase()] || d).join(',');
    const startTime = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

    const xmlContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${startTime}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek>${days.split(',').map(d => `<${d}/>`).join('')}</DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"</Arguments>
    </Exec>
  </Actions>
</Task>`;

    const xmlPath = path.join(app.getPath('temp'), `bob_task_${taskName}.xml`);
    fs.writeFileSync(xmlPath, xmlContent, 'utf-8');

    const { stdout, stderr } = await execFileAsync('schtasks', [
      '/Create', '/TN', taskName, '/XML', xmlPath, '/F'
    ]);

    // Clean up temp XML
    try { fs.unlinkSync(xmlPath); } catch (_) {}

    return { success: true, taskName, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('scheduler:listTasks', async () => {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      'Get-ScheduledTask | Where-Object { $_.TaskName -like "Bob_*" } | Select-Object TaskName, State | ConvertTo-Json'
    ]);
    const tasks = JSON.parse(stdout || '[]');
    return { success: true, tasks: Array.isArray(tasks) ? tasks : [tasks] };
  } catch (e) {
    return { success: true, tasks: [] };
  }
});

ipcMain.handle('scheduler:deleteTask', async (_, { taskName }) => {
  try {
    const { stdout, stderr } = await execFileAsync('schtasks', ['/Delete', '/TN', taskName, '/F']);
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

app.whenReady().then(async () => {
  // Fetch Composio toolkit summary once at startup
  try {
    cachedToolkitSummary = await composio.getToolkitSummary();
    console.log('[Composio] Toolkit summary loaded:', cachedToolkitSummary.map(s => s.displayName).join(', '));
  } catch (e) {
    console.error('[Composio] Failed to load toolkit summary:', e.message);
  }

  createWindow();

  globalShortcut.register('Ctrl+Space', () => {
    togglePopup();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});
