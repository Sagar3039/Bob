import { useCallback, useEffect, useRef, useState } from 'react';

const api = window.assistantAPI;

/**
 * Provides mic-based speech-to-text (local Whisper STT via main process)
 * and text-to-speech using either system voices or Microsoft Edge TTS.
 * Supports streaming TTS for Edge — speaks chunks as they arrive.
 */
export function useVoice() {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [ttsProvider, setTtsProvider] = useState('edge'); // 'system' or 'edge'

  // System voices
  const [systemVoices, setSystemVoices] = useState([]);
  const [selectedSystemVoice, setSelectedSystemVoice] = useState(null);
  const [rate, setRate] = useState(1.0);
  const [pitch, setPitch] = useState(1.0);

  // Edge voices
  const [edgeVoices, setEdgeVoices] = useState([]);
  const [selectedEdgeVoice, setSelectedEdgeVoice] = useState('en-GB-ThomasNeural');
  const [edgeRate, setEdgeRate] = useState(0);
  const [edgePitch, setEdgePitch] = useState(0);
  const [edgeVoicesLoading, setEdgeVoicesLoading] = useState(true);
  const [edgeVoicesError, setEdgeVoicesError] = useState(null);

  // Refs for audio and queue
  const audioRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sentenceBufferRef = useRef('');
  const streamingModeRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const resolveListenRef = useRef(null);
  const rejectListenRef = useRef(null);

  // ─── Sentence Splitting ───────────────────────────────────────────

  const DELIMITERS = /[.!?;]\s|\n/;
  const MAX_BUFFER = 400;
  const PREFERRED_SPLIT = 200;

  function cleanForSpeech(text) {
    if (!text) return '';
    return text
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '')   // Emoticons
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')   // Misc Symbols & Pictographs
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')   // Transport & Map
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')   // Flags
      .replace(/[\u{2600}-\u{26FF}]/gu, '')      // Misc Symbols
      .replace(/[\u{2700}-\u{27BF}]/gu, '')      // Dingbats
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')      // Variation Selectors
      .replace(/[\u{200D}]/gu, '')               // Zero Width Joiner
      .replace(/[\u{20E3}]/gu, '')               // Combining Enclosing Keycap
      .replace(/[\u{E0020}-\u{E007F}]/gu, '')   // Tags
      .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')   // Supplemental Symbols
      .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')   // Chess Symbols
      .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')   // Symbols & Pictographs Extended-A
      .replace(/\*+/g, '')                       // Asterisks
      .replace(/&/g, ' and ')                    // Ampersand → "and"
      .replace(/@/g, ' at ')                     // At sign → "at"
      .replace(/#+/g, '')                        // Hashtags
      .replace(/\s+/g, ' ')                      // Collapse whitespace
      .trim();
  }

  function extractSentence(buffer) {
    // Look for sentence delimiter
    const match = buffer.match(DELIMITERS);
    if (match && match.index !== undefined) {
      const end = match.index + match[0].length;
      return { sentence: buffer.slice(0, end).trim(), remaining: buffer.slice(end) };
    }
    // No delimiter — if buffer is large, split at last space
    if (buffer.length > MAX_BUFFER) {
      const lastSpace = buffer.lastIndexOf(' ', PREFERRED_SPLIT);
      if (lastSpace > 50) {
        return { sentence: buffer.slice(0, lastSpace).trim(), remaining: buffer.slice(lastSpace) };
      }
      // No good split point — force split
      return { sentence: buffer.slice(0, PREFERRED_SPLIT).trim(), remaining: buffer.slice(PREFERRED_SPLIT) };
    }
    return null; // Still buffering
  }

  // ─── Audio Queue Processing ───────────────────────────────────────

  function processQueue() {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

    const { audioBase64, onDone } = audioQueueRef.current.shift();
    isPlayingRef.current = true;

    // Convert base64 to blob
    const raw = atob(audioBase64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    const blob = new Blob([arr], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);

    const audio = new Audio();
    audioRef.current = audio;

    audio.onplay = () => setSpeaking(true);

    audio.onended = () => {
      URL.revokeObjectURL(url);
      isPlayingRef.current = false;
      setSpeaking(false);
      processQueue(); // Play next in queue
    };

    audio.onerror = (e) => {
      console.error('Audio playback error:', e);
      URL.revokeObjectURL(url);
      isPlayingRef.current = false;
      setSpeaking(false);
      processQueue();
    };

    audio.src = url;
    audio.play().catch(e => {
      console.error('Audio play failed:', e);
      URL.revokeObjectURL(url);
      isPlayingRef.current = false;
      processQueue();
    });
  }

  // ─── Edge TTS (batch mode) ────────────────────────────────────────

  const speakEdge = useCallback(async (text) => {
    const clean = cleanForSpeech(text);
    if (!api?.tts || !clean) return;
    setSpeaking(true);
    try {
      const rateStr = edgeRate >= 0 ? `+${edgeRate}%` : `${edgeRate}%`;
      const pitchStr = edgePitch >= 0 ? `+${edgePitch}Hz` : `${edgePitch}Hz`;

      const audioBase64 = await api.tts.speak(clean, {
        voice: selectedEdgeVoice,
        rate: rateStr,
        pitch: pitchStr
      });

      if (!audioBase64) { setSpeaking(false); return; }

      // Queue and play
      audioQueueRef.current.push({ audioBase64, onDone: null });
      processQueue();
    } catch (e) {
      console.error('Edge TTS error:', e);
      setSpeaking(false);
    }
  }, [selectedEdgeVoice, edgeRate, edgePitch]);

  // ─── Streaming TTS functions ──────────────────────────────────────

  const speakChunk = useCallback(async (text) => {
    const clean = cleanForSpeech(text);
    if (!api?.tts || !clean) return;
    try {
      const rateStr = edgeRate >= 0 ? `+${edgeRate}%` : `${edgeRate}%`;
      const pitchStr = edgePitch >= 0 ? `+${edgePitch}Hz` : `${edgePitch}Hz`;

      const audioBase64 = await api.tts.speak(clean, {
        voice: selectedEdgeVoice,
        rate: rateStr,
        pitch: pitchStr
      });

      if (audioBase64) {
        audioQueueRef.current.push({ audioBase64, onDone: null });
        processQueue();
      }
    } catch (e) {
      console.error('Edge TTS chunk error:', e);
    }
  }, [selectedEdgeVoice, edgeRate, edgePitch]);

  const pushChunk = useCallback((text) => {
    if (!text.trim()) return;
    sentenceBufferRef.current += text;
    while (true) {
      const result = extractSentence(sentenceBufferRef.current);
      if (!result) break; // Still buffering
      sentenceBufferRef.current = result.remaining;
      speakChunk(result.sentence);
    }
  }, [speakChunk]);

  const flushChunks = useCallback(() => {
    const remaining = sentenceBufferRef.current.trim();
    sentenceBufferRef.current = '';
    if (remaining) {
      speakChunk(remaining);
    }
  }, [speakChunk]);

  const clearQueue = useCallback(() => {
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    sentenceBufferRef.current = '';
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  // ─── System TTS ───────────────────────────────────────────────────

  const speakSystem = useCallback((text) => {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;
    if (selectedSystemVoice) utterance.voice = selectedSystemVoice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, [selectedSystemVoice, rate, pitch]);

  // ─── Main speak (batch mode) ──────────────────────────────────────

  const speak = useCallback((text) => {
    if (ttsProvider === 'edge') {
      speakEdge(text);
    } else {
      speakSystem(text);
    }
  }, [ttsProvider, speakSystem, speakEdge]);

  const stopSpeaking = useCallback(() => {
    clearQueue();
    window.speechSynthesis?.cancel();
  }, [clearQueue]);

  // ─── Voice loading ────────────────────────────────────────────────

  useEffect(() => {
    const loadVoices = () => {
      const available = window.speechSynthesis?.getVoices() || [];
      const englishVoices = available.filter(v => v.lang.startsWith('en'));
      setSystemVoices(englishVoices.length > 0 ? englishVoices : available);
    };
    loadVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
  }, []);

  useEffect(() => {
    if (!api?.tts) { setEdgeVoicesLoading(false); return; }
    setEdgeVoicesLoading(true);
    setEdgeVoicesError(null);
    api.tts.getEdgeVoices().then(voices => {
      if (Array.isArray(voices) && voices.length > 0) {
        const englishVoices = voices.filter(v => v.Locale?.startsWith('en'));
        setEdgeVoices(englishVoices.length > 0 ? englishVoices : voices);
      } else {
        setEdgeVoicesError('No voices available');
      }
    }).catch(err => {
      setEdgeVoicesError(err.message || 'Failed to load voices');
    }).finally(() => {
      setEdgeVoicesLoading(false);
    });
  }, []);

  useEffect(() => {
    if (systemVoices.length > 0 && !selectedSystemVoice) {
      setSelectedSystemVoice(systemVoices[0]);
    }
  }, [systemVoices, selectedSystemVoice]);

  // ─── Voice input (local Whisper STT via main process) ──────────────

  // Convert WebM blob to WAV blob using AudioContext (renderer has AudioContext)
  // Resamples to 16kHz mono (what Whisper expects) and boosts levels
  async function webmToWav(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    // Resample to 16kHz using OfflineAudioContext
    const targetRate = 16000;
    const duration = decodedBuffer.duration;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * targetRate), targetRate);

    // Create source from decoded buffer
    const source = offlineCtx.createBufferSource();
    source.buffer = decodedBuffer;

    // Create gain node to boost volume
    const gain = offlineCtx.createGain();
    gain.gain.value = 2.0; // Boost gain

    source.connect(gain);
    gain.connect(offlineCtx.destination);
    source.start(0);

    const resampledBuffer = await offlineCtx.startRendering();

    // Get the resampled mono data
    const samples = resampledBuffer.getChannelData(0);

    // Normalize: find peak and scale
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    const scale = peak > 0 ? 0.9 / peak : 1.0;

    // Encode as 16-bit PCM WAV (mono, 16kHz)
    const numChannels = 1;
    const sampleRate = targetRate;
    const length = samples.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const bufferSize = 44 + dataSize;
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write normalized mono PCM samples
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i] * scale));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }

    audioCtx.close();
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // Convert ArrayBuffer to base64 without blowing call stack
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  const startTranscribe = useCallback(async (audioBlob) => {
    setListening(false);
    setTranscribing(true);

    try {
      // Convert WebM to WAV so Node.js can process it without AudioContext
      const wavBlob = await webmToWav(audioBlob);
      const arrayBuffer = await wavBlob.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);

      if (!api?.stt) {
        throw new Error('Speech recognition not available.');
      }

      const result = await api.stt.transcribe(base64);
      setTranscribing(false);
      return result?.text?.trim() || '';
    } catch (err) {
      setTranscribing(false);
      throw err;
    }
  }, []);

  const listen = useCallback(() => {
    return new Promise(async (resolve, reject) => {
      let stream = null;

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        setListening(true);

        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          mediaRecorderRef.current = null;

          if (audioChunksRef.current.length === 0) {
            setListening(false);
            reject(new Error('No audio recorded.'));
            return;
          }

          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          audioChunksRef.current = [];

          try {
            const text = await startTranscribe(audioBlob);
            if (text) {
              resolve(text);
            } else {
              reject(new Error('Could not understand audio.'));
            }
          } catch (err) {
            reject(err);
          }
        };

        // Auto-stop after 30 seconds
        setTimeout(() => {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          }
        }, 30000);

        mediaRecorder.start(100); // collect in 100ms chunks
      } catch (err) {
        setListening(false);
        stream?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        reject(new Error('Microphone access denied or unavailable.'));
      }
    });
  }, [startTranscribe]);

  // Stop recording and send audio for transcription
  const sendVoice = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Cancel recording without transcribing
  const cancelRecording = useCallback(() => {
    audioChunksRef.current = [];
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    setListening(false);
  }, []);

  const refreshEdgeVoices = useCallback(() => {
    if (!api?.tts) return;
    setEdgeVoicesLoading(true);
    setEdgeVoicesError(null);
    api.tts.getEdgeVoices().then(voices => {
      if (Array.isArray(voices) && voices.length > 0) {
        const englishVoices = voices.filter(v => v.Locale?.startsWith('en'));
        setEdgeVoices(englishVoices.length > 0 ? englishVoices : voices);
      } else {
        setEdgeVoicesError('No voices available');
      }
    }).catch(err => {
      setEdgeVoicesError(err.message || 'Failed to load voices');
    }).finally(() => {
      setEdgeVoicesLoading(false);
    });
  }, []);

  return {
    listen, listening, transcribing, sendVoice, cancelRecording,
    speak, speaking, stopSpeaking, voiceSupported,
    ttsProvider, setTtsProvider,
    systemVoices, selectedSystemVoice, setSelectedSystemVoice,
    rate, setRate, pitch, setPitch,
    edgeVoices, selectedEdgeVoice, setSelectedEdgeVoice,
    edgeRate, setEdgeRate, edgePitch, setEdgePitch,
    edgeVoicesLoading, edgeVoicesError, refreshEdgeVoices,
    pushChunk, flushChunks, clearQueue
  };
}
