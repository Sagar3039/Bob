const queryEl = document.getElementById('query');
const responseEl = document.getElementById('response-area');
const voiceBtn = document.getElementById('voice-toggle');
const memoryBtn = document.getElementById('memory-btn');
const toolsBtn = document.getElementById('tools-btn');

let voiceOn = false;
let answering = false;
let currentModel = '';

// ─── Audio Queue ──────────────────────────────────────────────────
const audioQueue = [];
let isPlaying = false;
let currentAudio = null;

function processQueue() {
  if (isPlaying || audioQueue.length === 0) return;

  isPlaying = true;
  const { audioBase64 } = audioQueue.shift();

  const raw = atob(audioBase64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const blob = new Blob([arr], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);

  const audio = new Audio();
  currentAudio = audio;

  audio.onended = () => {
    URL.revokeObjectURL(url);
    isPlaying = false;
    currentAudio = null;
    processQueue();
  };

  audio.onerror = () => {
    URL.revokeObjectURL(url);
    isPlaying = false;
    currentAudio = null;
    processQueue();
  };

  audio.src = url;
  audio.play().catch(() => {
    URL.revokeObjectURL(url);
    isPlaying = false;
    currentAudio = null;
    processQueue();
  });
}

function enqueueAudio(audioBase64) {
  audioQueue.push({ audioBase64 });
  processQueue();
}

function clearAudioQueue() {
  audioQueue.length = 0;
  isPlaying = false;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

// ─── Sentence Splitting ──────────────────────────────────────────
const DELIMITERS = /[.!?;]\s|\n/;
const MAX_BUFFER = 400;
const PREFERRED_SPLIT = 200;

function cleanForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{200D}]/gu, '')
    .replace(/[\u{20E3}]/gu, '')
    .replace(/[\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/\*+/g, '')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/#+/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSentence(buffer) {
  const match = buffer.match(DELIMITERS);
  if (match && match.index !== undefined) {
    const end = match.index + match[0].length;
    return { sentence: buffer.slice(0, end).trim(), remaining: buffer.slice(end) };
  }
  if (buffer.length > MAX_BUFFER) {
    const lastSpace = buffer.lastIndexOf(' ', PREFERRED_SPLIT);
    if (lastSpace > 50) {
      return { sentence: buffer.slice(0, lastSpace).trim(), remaining: buffer.slice(lastSpace) };
    }
    return { sentence: buffer.slice(0, PREFERRED_SPLIT).trim(), remaining: buffer.slice(PREFERRED_SPLIT) };
  }
  return null;
}

// ─── Streaming TTS ───────────────────────────────────────────────
let sentenceBuffer = '';

function pushChunk(text) {
  if (!text.trim() || !voiceOn) return;
  sentenceBuffer += text;
  while (true) {
    const result = extractSentence(sentenceBuffer);
    if (!result) break;
    sentenceBuffer = result.remaining;
    speakSentence(result.sentence);
  }
}

function flushChunks() {
  const remaining = sentenceBuffer.trim();
  sentenceBuffer = '';
  if (remaining && voiceOn) {
    speakSentence(remaining);
  }
}

async function speakSentence(text) {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  try {
    const audioBase64 = await window.electronAPI.tts(clean);
    if (audioBase64) enqueueAudio(audioBase64);
  } catch {}
}

// ─── Response Area Toggle ────────────────────────────────────────
function showResponse() {
  responseEl.classList.add('visible');
  window.electronAPI.resize?.(420);
}

function hideResponse() {
  responseEl.classList.remove('visible');
  responseEl.innerHTML = '';
  delete responseEl.dataset.full;
  window.electronAPI.resize?.(90);
}

// ─── UI ──────────────────────────────────────────────────────────
voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  voiceBtn.classList.toggle('active', voiceOn);
  if (!voiceOn) {
    clearAudioQueue();
    sentenceBuffer = '';
  }
});

if (memoryBtn) {
  memoryBtn.addEventListener('click', async () => {
    try {
      const ctx = await window.electronAPI.memory?.getContext?.('', 'popup');
      showResponse();
      if (ctx && ctx.trim()) {
        responseEl.textContent = ctx;
      } else {
        responseEl.innerHTML = `<span style="color:rgba(0,0,0,0.5)">No memories yet. Start chatting to build context.</span>`;
      }
    } catch {
      showResponse();
      responseEl.innerHTML = `<span style="color:rgba(0,0,0,0.5)">Could not load memories.</span>`;
    }
  });
}

if (toolsBtn) {
  toolsBtn.addEventListener('click', async () => {
    try {
      const tools = await window.electronAPI.composio.getTools();
      showResponse();
      if (!tools || tools.length === 0) {
        responseEl.innerHTML = `<span style="color:rgba(0,0,0,0.5)">No tools connected. Open Bob to connect services.</span>`;
        return;
      }
      const list = tools.slice(0, 20).map(t => {
        const name = t.slug || t.name || 'unknown';
        const desc = t.description ? ` - ${t.description.substring(0, 60)}` : '';
        return `<div style="padding:3px 0;border-bottom:1px solid rgba(0,0,0,0.04)"><strong>${name}</strong><span style="color:rgba(0,0,0,0.4);font-size:11px">${desc}</span></div>`;
      }).join('');
      responseEl.innerHTML = `<div style="font-size:12px">${list}</div>`;
    } catch {
      showResponse();
      responseEl.innerHTML = `<span style="color:rgba(0,0,0,0.5)">Could not load tools.</span>`;
    }
  });
}

async function loadModel() {
  try {
    currentModel = await window.electronAPI.getModel();
  } catch {}
}

window.electronAPI.onChunk((data) => {
  if (data.error) {
    showResponse();
    responseEl.innerHTML = `<span class="error">Error: ${data.error}</span>`;
    answering = false;
    return;
  }
  if (data.toolCall) {
    const full = responseEl.dataset.full || '';
    responseEl.dataset.full = full + `\nExecuting ${data.toolCall}...`;
    responseEl.textContent = responseEl.dataset.full;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    responseEl.appendChild(cursor);
    responseEl.scrollTop = responseEl.scrollHeight;
  }
  if (data.toolResult) {
    const { name, success, data: resultData } = data.toolResult;
    const resultText = success
      ? `\n${name} completed.\n${JSON.stringify(resultData, null, 2)}`
      : `\n${name} failed: ${resultData}`;
    const full = responseEl.dataset.full || '';
    responseEl.dataset.full = full + resultText;
    const display = responseEl.dataset.full
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ');
    responseEl.textContent = display;
    responseEl.scrollTop = responseEl.scrollHeight;
  }
  if (data.text) {
    showResponse();
    const full = (responseEl.dataset.full || '') + data.text;
    responseEl.dataset.full = full;
    const display = full
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ');
    const cursor = responseEl.querySelector('.cursor');
    responseEl.textContent = display;
    if (cursor) responseEl.appendChild(cursor);
    else {
      const c = document.createElement('span');
      c.className = 'cursor';
      responseEl.appendChild(c);
    }
    responseEl.scrollTop = responseEl.scrollHeight;
    pushChunk(data.text);
  }
  if (data.done) {
    const cursor = responseEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    answering = false;
    flushChunks();
    delete responseEl.dataset.full;
  }
});

async function ask(query) {
  if (answering) return;
  if (!query.trim()) return;

  queryEl.value = '';
  answering = true;
  clearAudioQueue();
  sentenceBuffer = '';
  responseEl.innerHTML = '';
  responseEl.dataset.full = '';

  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  responseEl.appendChild(cursor);

  await window.electronAPI.chat(query, currentModel);
}

queryEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const q = queryEl.value.trim();
    if (q) ask(q);
  }
  if (e.key === 'Escape') {
    if (answering) clearAudioQueue();
    hideResponse();
    window.electronAPI.hide?.();
  }
});

loadModel();
queryEl.focus();
