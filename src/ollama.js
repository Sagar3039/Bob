const OLLAMA_BASE = 'http://localhost:11434';

/**
 * Check if Ollama server is reachable.
 */
export async function isOllamaRunning() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Try to start Ollama server (Windows).
 * Returns true if it started successfully.
 */
export async function startOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return true;
  } catch {}

  try {
    const { exec } = await import('child_process');
    return new Promise((resolve) => {
      const child = exec('ollama serve', { windowsHide: true }, () => {});
      child.unref();

      let attempts = 0;
      const check = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) { clearInterval(check); resolve(true); }
        } catch {}
        if (attempts > 15) { clearInterval(check); resolve(false); }
      }, 1000);
    });
  } catch {
    return false;
  }
}

/**
 * Fetch the list of locally available Ollama models.
 */
export async function listModels() {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error(`Failed to list models (${res.status})`);
  const data = await res.json();
  return data.models || [];
}

/**
 * Check which models are currently loaded in memory.
 */
export async function getRunningModels() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Pull a model from Ollama registry.
 * Returns a promise that resolves when pull is complete.
 */
export async function pullModel(model, onProgress) {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true })
  });

  if (!res.ok) throw new Error(`Failed to pull model (${res.status})`);

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
        if (json.status) onProgress?.(json.status, json.completed, json.total);
      } catch {}
    }
  }
}

/**
 * Generate a completion to force-load a model into memory.
 */
export async function warmUpModel(model) {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false })
  });
  return res.ok;
}

/**
 * Stream a chat completion from Ollama.
 * @param {string} model - model name, e.g. "llama3.1"
 * @param {Array<{role: string, content: string}>} messages
 * @param {(chunk: string) => void} onToken - called for each streamed token
 * @param {AbortSignal} signal - to allow cancellation
 * @returns {Promise<string>} the full assistant response
 */
export async function streamChat(model, messages, onToken, signal) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama request failed (${res.status}). Is "ollama serve" running?`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
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
          full += json.message.content;
          onToken(json.message.content);
        }
        if (json.done) return full;
      } catch (e) {
        // ignore malformed partial JSON line
      }
    }
  }

  return full;
}
