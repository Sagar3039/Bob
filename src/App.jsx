import React, { useEffect, useRef, useState, useCallback } from 'react';
import { isOllamaRunning, startOllama, listModels, getRunningModels, pullModel, warmUpModel, streamChat } from './ollama.js';
import { useVoice } from './useVoice.js';

const SYSTEM_PROMPT = `You are Bob — a personal AI assistant. Part JARVIS, part brutally honest best friend. You are built by Sagar Karmakar as part of his Bob AI project. You are running locally on his machine using Ollama.

## Your Capabilities
- You can speak aloud using Edge TTS (Microsoft's text-to-speech). When the user enables auto-speak, your responses are spoken in real-time using a deep British male voice (en-GB-ThomasNeural).
- You can listen: the user can speak to you via microphone. You receive their speech as text (converted by Whisper STT).
- You remember things across conversations. Past conversations are stored and you can recall facts, stories, goals, and preferences from them. When the user asks "what did we talk about before" or references a past topic, you have access to that context.
- You have external tool access via Composio — including GitHub, Gmail, Google Tasks, Google Drive, Google Calendar, Notion, and LinkedIn. When you need to use a tool, respond with [TOOL_CALL: TOOL_NAME({...})] and the system will execute it for you.
- Tool slugs are UPPERCASE_SNAKE_CASE (e.g., GOOGLESUPER_INSERT_TASK, GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE). Always use the exact slug format from the tool list.
- When using a tool, you MUST include all REQUIRED parameters. Common required params: title (for tasks), recipient_email (for emails), subject/body (for emails). Optional params like "due" can be added if the user specifies.
- Example: To create a task named "DSA" due July 20, output: [TOOL_CALL: GOOGLESUPER_INSERT_TASK({"title": "DSA", "due": "2026-07-20", "tasklist_id": "@default"})]
- When the user asks "what tools do you have" or "show me your tools", list ONLY the service names (GitHub, Gmail, LinkedIn, etc.) with a brief description. Do NOT list individual tool slugs unless specifically asked.
- When the user asks about a specific service (e.g. "what can you do with gmail?"), list the available tools for that service with their required and optional parameters.
- If a tool fails because the service is not connected, ask the user for confirmation to connect it before proceeding.
- You run locally via Ollama for your brain, but your tool access (Composio) connects to cloud services when needed. Edge TTS powers your voice, Whisper powers your ears.
- You are loaded on the model: gemma4:31b-cloud.

## Your Personality
- Be direct. No corporate fluff. Talk like a smart friend who happens to know everything.
- When Sagar shares his marks, grades, or goals — acknowledge them, contextualize them, and give honest feedback.
- If he's slacking, call him out. If he's doing well, give him credit. No participation trophies.
- Use **bold** for emphasis. Use headers and lists when explaining things.
- You can roleplay, joke around, and be creative — but always come back to being useful.
- Never pretend to have capabilities you don't have. If you can't do something, say so.
- When asked about past conversations, reference the context provided to you naturally — don't say "I don't have memory" if the context is there.

## About Sagar Karmakar
- BCA student at Midnapore College (Autonomous), Vidyasagar University, graduating 2026
- Career goal: Software Engineer at Microsoft
- Wants to pursue MSc Computer Science abroad — preferred countries: Germany, Italy, France, Austria, Finland, Ireland, Netherlands
- GitHub: https://github.com/Sagar3039
- Portfolio: https://sagarportfolio2004.netlify.app/
- Email: sagarkarmakar3.10.2004@gmail.com
- Skills: Python, Java, C++, React, FastAPI, Android, Git
- Projects: Bob AI, RacePulse, Portfolio, AI Voice Assistant

## How You Should Respond
- Keep responses focused and useful. Don't ramble unless the conversation calls for it.
- For code, give clean working code with brief explanations.
- For career advice, be brutally practical — not motivational poster material.
- For study abroad, give actionable steps, not generic "research universities" advice.
- Remember Sagar's context: he's a BCA student from India aiming for Microsoft and a European MSc.
- NEVER use asterisks (*), ampersands (&), or at signs (@) in your responses. Use plain English words instead. Say "and" not "&", say "at" not "@", use plain text formatting instead of markdown bold/italic.`;

const DEFAULT_MODEL = 'gemma4:31b-cloud';
const WELCOME_MSG = { role: 'assistant', content: "Bob here. Online and at your service. What shall we work on today?" };

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

  // Personality state
  const [personality, setPersonality] = useState({
    name: 'Bob',
    tone: 'JARVIS-inspired, brutally honest best friend',
    style: 'direct, no corporate fluff, talk like a smart friend',
    emoji: false,
    custom: ''
  });

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
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) {
      setCurrentSessionId(null);
      setMessages([WELCOME_MSG]);
    }
  }, [currentSessionId]);

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
        setPersonality({ name: 'Bob', tone: 'JARVIS-inspired, brutally honest best friend', style: 'direct, no corporate fluff, talk like a smart friend', emoji: false, custom: '' });
        return 'Personality reset to default.';
      },
      '/personality': () => {
        return `Current personality:\n- Name: ${personality.name}\n- Tone: ${personality.tone}\n- Style: ${personality.style}\n- Emoji: ${personality.emoji ? 'on' : 'off'}\n- Custom: ${personality.custom || '(none)'}\n\nCommands:\n/name <name> — Change name\n/tone <tone> — Change tone\n/style <style> — Change style\n/emoji on|off — Toggle emoji\n/set <instruction> — Set custom instruction\n/reset — Reset to default`;
      },
      '/help': () => {
        return 'Commands:\n/personality — View and edit personality\n/name <name> — Change name\n/tone <tone> — Change tone\n/style <style> — Change style\n/emoji on|off — Toggle emoji\n/set <instruction> — Set custom instruction\n/reset — Reset personality\n/clear — Clear current conversation\n模型 — Show current model info';
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

    // Handle pending tool connection confirmation
    if (pendingToolConfirm) {
      const answer = content.toLowerCase().trim();
      const { toolName, args, toolkit } = pendingToolConfirm;
      
      if (answer === 'yes' || answer === 'y' || answer === 'connect') {
        setPendingToolConfirm(null);
        setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: `Opening ${toolkit} authorization page... Please complete the authorization in your browser.` }]);
        setInput('');
        
        try {
          // Start connection flow
          await api.composio.startConnect(toolkit);
          
          setMessages((prev) => [...prev, { role: 'assistant', content: `Waiting for you to authorize ${toolkit}...` }]);
          
          // Wait for connection (2 minute timeout)
          const connected = await api.composio.waitForConnection(toolkit, 120000);
          
          if (connected) {
            setMessages((prev) => [...prev, { role: 'assistant', content: `${toolkit} connected successfully! Retrying ${toolName}...` }]);
            
            // Retry the tool execution
            const retryResult = await api.composio.execute(toolName, args);
            const retryMsg = retryResult.success
              ? `${toolName} completed successfully.\n\nResult:\n${JSON.stringify(retryResult.result, null, 2)}`
              : `${toolName} failed: ${retryResult.error?.message || retryResult.error}`;
            setMessages((prev) => [...prev, { role: 'assistant', content: retryMsg }]);
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
    const personalityBlock = `## Current Identity
You are "${personality.name}" — ${personality.tone}.
Your communication style: ${personality.style}.
Emoji usage: ${personality.emoji ? 'Use emojis naturally in responses.' : 'Do NOT use emojis.'}
${personality.custom ? `Special instruction: ${personality.custom}` : ''}`;

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

      // Check for Composio tool call(s) in the response — there can be more than one
      if (api?.composio && fullReply) {
        const toolMatches = [...fullReply.matchAll(/\[TOOL_CALL:\s*(\w+)\((.*?)\)\]/gs)];
        for (const toolMatch of toolMatches) {
          const toolName = toolMatch[1];
          const argsStr = toolMatch[2].trim();
          let args = {};
          if (argsStr) {
            try {
              args = JSON.parse(argsStr);
            } catch {
              const regex = /(\w+)\s*:\s*"([^"]*)"/g;
              let m;
              while ((m = regex.exec(argsStr)) !== null) {
                args[m[1]] = m[2];
              }
            }
          }
          setMessages((prev) => [...prev, { role: 'assistant', content: `Executing ${toolName}...` }]);
          try {
            const result = await api.composio.execute(toolName, args);
            
            if (result.success) {
              const resultMsg = `${toolName} completed successfully.\n\nResult:\n${JSON.stringify(result.result, null, 2)}`;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: resultMsg };
                return updated;
              });
            } else {
              const error = result.error;
              // Handle structured NOT_CONNECTED error - set pending confirmation
              if (error && error.type === 'NOT_CONNECTED') {
                setPendingToolConfirm({ toolName, args, toolkit: error.toolkit });
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: 'assistant', content: `${error.suggestion}\n\nType "yes" to connect ${error.toolkit}, or "no" to cancel.` };
                  return updated;
                });
              } else {
                // Handle other error types
                const errorMsg = error?.message || error || 'Unknown error';
                const suggestion = error?.suggestion ? `\n${error.suggestion}` : '';
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: 'assistant', content: `${toolName} failed: ${errorMsg}${suggestion}` };
                  return updated;
                });
              }
            }
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
      setError(e.message || 'Microphone error.');
    }
  }

  function handleSendVoice() {
    sendVoice();
  }

  function handleCancelRecording() {
    cancelRecording();
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }

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
    if (val.startsWith('/')) {
      setCmdFilter(val.split(' ')[0]);
      setShowCmds(true);
      setCmdIdx(0);
    } else {
      setShowCmds(false);
    }
  }

  function handleInputKeyDown(e) {
    if (!showCmds || filteredCommands.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCmdIdx(i => (i + 1) % filteredCommands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCmdIdx(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      selectCommand(filteredCommands[cmdIdx].cmd);
    } else if (e.key === 'Escape') {
      setShowCmds(false);
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
              🔊 Voice Settings
            </button>
          </div>
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
            <div className="content">{m.content || (isThinking && i === messages.length - 1 ? '…' : '')}</div>
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
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                placeholder={selectedModel ? 'Type a message… (try / for commands)' : 'Load a model first'}
                disabled={!selectedModel}
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
