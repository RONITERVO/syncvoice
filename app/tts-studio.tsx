"use client";

import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import {
  AudioLines,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileArchive,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SAMPLE_RATE = 24_000;
const MAX_CHARACTERS = 8_000;
const DEFAULT_TEXT = `There is a particular kind of quiet that arrives just before an idea becomes real. A held breath. A blank page. Then, suddenly, the first word — clear, warm, and entirely your own.`;

const VOICES = [
  { id: "Kore", label: "Kore", note: "Warm & composed" },
  { id: "Aoede", label: "Aoede", note: "Airy & expressive" },
  { id: "Charon", label: "Charon", note: "Measured & rich" },
  { id: "Fenrir", label: "Fenrir", note: "Confident & vivid" },
  { id: "Puck", label: "Puck", note: "Bright & lively" },
  { id: "Leda", label: "Leda", note: "Clear & youthful" },
  { id: "Orus", label: "Orus", note: "Firm & direct" },
  { id: "Zephyr", label: "Zephyr", note: "Gentle & calm" },
];

type StudioState = "idle" | "connecting" | "generating" | "ready" | "error";
type WordCue = { id: number; text: string; startSample: number; endSample: number };
type CaptionCue = { startSeconds: number; endSeconds: number; text: string };

function decodePcm(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)).slice();
}

function mergePcm(chunks: Int16Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function pcmToWavBlob(pcm: Int16Array) {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return new Blob([buffer], { type: "audio/wav" });
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function createWaveform(pcm: Int16Array | null, bars = 72) {
  if (!pcm?.length) {
    return Array.from({ length: bars }, (_, index) => 0.18 + Math.abs(Math.sin(index * 0.47)) * 0.34);
  }
  const block = Math.max(1, Math.floor(pcm.length / bars));
  return Array.from({ length: bars }, (_, bar) => {
    let peak = 0;
    const start = bar * block;
    const end = Math.min(pcm.length, start + block);
    for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(pcm[index]) / 32768);
    return Math.max(0.12, Math.min(1, Math.sqrt(peak)));
  });
}

function appendTranscript(previous: string, fragment: string) {
  const normalized = fragment.replace(/\s+/g, " ").trim();
  if (!normalized) return previous;
  if (!previous) return normalized;
  if (/^[,.;:!?)}\]]/.test(normalized)) return `${previous}${normalized}`;
  return `${previous} ${normalized}`;
}

function formatCaptionTime(seconds: number, decimalMark: "." | ",") {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimalMark}${String(millis).padStart(3, "0")}`;
}

function createCaptionCues(wordCues: WordCue[], wordsPerCaption: number, delayMs: number): CaptionCue[] {
  const groups: WordCue[][] = [];
  let current: WordCue[] = [];
  for (const cue of wordCues) {
    current.push(cue);
    if (current.length >= wordsPerCaption || /[.!?][\]"')]*$/.test(cue.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  const delaySeconds = delayMs / 1_000;
  return groups.map((group) => ({
    startSeconds: Math.max(0, group[0].startSample / SAMPLE_RATE + delaySeconds),
    endSeconds: Math.max(0.08, group[group.length - 1].endSample / SAMPLE_RATE + delaySeconds),
    text: group.map((cue) => cue.text).join(" "),
  }));
}

function normalizeWordCueTiming(wordCues: WordCue[], totalSamples: number) {
  if (!wordCues.length || totalSamples <= 0) return wordCues;
  return wordCues.map((cue, index) => ({
    ...cue,
    startSample: Math.round((totalSamples * index) / wordCues.length),
    endSample: Math.round((totalSamples * (index + 1)) / wordCues.length),
  }));
}

function createWebVtt(captions: CaptionCue[]) {
  return `WEBVTT\n\n${captions.map((caption, index) => `${index + 1}\n${formatCaptionTime(caption.startSeconds, ".")} --> ${formatCaptionTime(caption.endSeconds, ".")}\n${caption.text}`).join("\n\n")}\n`;
}

function createSrt(captions: CaptionCue[]) {
  return `${captions.map((caption, index) => `${index + 1}\n${formatCaptionTime(caption.startSeconds, ",")} --> ${formatCaptionTime(caption.endSeconds, ",")}\n${caption.text}`).join("\n\n")}\n`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function readStoredNumber(key: string, fallback: number, minimum: number, maximum: number) {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function readStoredBoolean(key: string, fallback = false) {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
}

export function TtsStudio() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voice, setVoice] = useState("Kore");
  const [state, setState] = useState<StudioState>("idle");
  const [status, setStatus] = useState("Ready when you are");
  const [transcript, setTranscript] = useState("");
  const [cues, setCues] = useState<WordCue[]>([]);
  const cuesRef = useRef<WordCue[]>([]);
  const observedCuesRef = useRef<WordCue[]>([]);
  const transcriptRef = useRef("");
  const [activeCue, setActiveCue] = useState(-1);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [highlightDelayMs, setHighlightDelayMs] = useState(() => readStoredNumber("syncvoice-highlight-delay-ms", 0, -2_000, 2_000));
  const [normalizeTranscriptTiming, setNormalizeTranscriptTiming] = useState(() => readStoredBoolean("syncvoice-normalize-transcript-timing"));
  const [captionWords, setCaptionWords] = useState(() => readStoredNumber("syncvoice-caption-words", 6, 3, 12));
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState(() => createWaveform(null));

  const sessionRef = useRef<Session | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioChunksRef = useRef<Int16Array[]>([]);
  const generatedPcmRef = useRef<Int16Array | null>(null);
  const audioSamplesRef = useRef(0);
  const cueEndSampleRef = useRef(0);
  const cueIdRef = useRef(0);
  const nextStartRef = useRef(0);
  const playbackOriginRef = useRef<number | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const animationRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const currentAudioUrlRef = useRef<string | null>(null);
  const highlightDelayRef = useRef(highlightDelayMs);

  const selectedVoice = VOICES.find((item) => item.id === voice) ?? VOICES[0];
  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text]);
  const estimate = Math.max(1, Math.round(words / 2.45));
  const busy = state === "connecting" || state === "generating";

  const changeHighlightDelay = useCallback((nextDelay: number) => {
    const clamped = Math.max(-2_000, Math.min(2_000, Math.round(nextDelay / 25) * 25));
    highlightDelayRef.current = clamped;
    setHighlightDelayMs(clamped);
  }, []);

  const changeNormalizeTranscriptTiming = useCallback((enabled: boolean) => {
    setNormalizeTranscriptTiming(enabled);
    const observed = observedCuesRef.current;
    if (!generatedPcmRef.current?.length || !observed.length) return;
    const nextCues = enabled ? normalizeWordCueTiming(observed, generatedPcmRef.current.length) : observed;
    cuesRef.current = nextCues;
    setCues(nextCues);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("syncvoice-highlight-delay-ms", String(highlightDelayMs));
    window.localStorage.setItem("syncvoice-caption-words", String(captionWords));
    window.localStorage.setItem("syncvoice-normalize-transcript-timing", String(normalizeTranscriptTiming));
  }, [captionWords, highlightDelayMs, normalizeTranscriptTiming]);

  const revokeAudioUrl = useCallback(() => {
    if (currentAudioUrlRef.current) URL.revokeObjectURL(currentAudioUrlRef.current);
    currentAudioUrlRef.current = null;
    setAudioUrl(null);
  }, []);

  const stopPlaybackInfrastructure = useCallback(async () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    for (const source of activeSourcesRef.current) {
      try { source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    activeSourcesRef.current = [];
    audioElementRef.current?.pause();
    audioElementRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      try { await audioContextRef.current.close(); } catch { /* browser is already closing it */ }
    }
    audioContextRef.current = null;
    playbackOriginRef.current = null;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const updateCuePosition = useCallback((sample: number) => {
    setActiveCue((current) => {
      let next = -1;
      const currentCues = cuesRef.current;
      const adjustedSample = sample - (highlightDelayRef.current / 1_000) * SAMPLE_RATE;
      for (let index = 0; index < currentCues.length; index += 1) {
        if (adjustedSample >= currentCues[index].startSample) next = index;
        if (adjustedSample < currentCues[index].endSample) break;
      }
      return next === current ? current : next;
    });
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      let elapsed = 0;
      if (audioElementRef.current) {
        elapsed = audioElementRef.current.currentTime;
      } else if (audioContextRef.current && playbackOriginRef.current !== null) {
        elapsed = Math.max(0, audioContextRef.current.currentTime - playbackOriginRef.current);
      }
      const sample = elapsed * SAMPLE_RATE;
      const total = Math.max(audioSamplesRef.current, 1);
      setProgress(Math.min(1, sample / total));
      updateCuePosition(sample);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [isPlaying, updateCuePosition]);

  const addTranscriptFragment = useCallback((fragment: string) => {
    const normalized = fragment.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    transcriptRef.current = appendTranscript(transcriptRef.current, normalized);
    setTranscript(transcriptRef.current);
    const tokens = normalized.match(/\S+/g) ?? [];
    if (!tokens.length) return;
    const startSample = cueEndSampleRef.current;
    const observedEnd = audioSamplesRef.current;
    const endSample = Math.max(observedEnd, startSample + tokens.length * 1_800);
    const span = Math.max(tokens.length, endSample - startSample);
    const nextCues = tokens.map((token, index) => ({
      id: cueIdRef.current++,
      text: token,
      startSample: Math.round(startSample + (span * index) / tokens.length),
      endSample: Math.round(startSample + (span * (index + 1)) / tokens.length),
    }));
    cueEndSampleRef.current = endSample;
    observedCuesRef.current = [...observedCuesRef.current, ...nextCues];
    cuesRef.current = observedCuesRef.current;
    setCues(observedCuesRef.current);
  }, []);

  const scheduleAudio = useCallback((pcm: Int16Array) => {
    const context = audioContextRef.current;
    if (!context) return;
    const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      const index = activeSourcesRef.current.indexOf(source);
      if (index >= 0) activeSourcesRef.current.splice(index, 1);
      try { source.disconnect(); } catch { /* already disconnected */ }
    };
    const startAt = Math.max(context.currentTime + 0.025, nextStartRef.current);
    if (playbackOriginRef.current === null) playbackOriginRef.current = startAt;
    source.start(startAt);
    nextStartRef.current = startAt + buffer.duration;
    activeSourcesRef.current.push(source);
  }, []);

  const finishGeneration = useCallback((inputText: string) => {
    const merged = mergePcm(audioChunksRef.current);
    if (!merged.length) {
      setState("error");
      setError("Gemini completed the turn without returning audio. Please try again.");
      setStatus("No audio received");
      setIsPlaying(false);
      return;
    }
    if (!cuesRef.current.length && !transcriptRef.current) {
      const fallbackWords = inputText.match(/\S+/g) ?? [];
      const fallbackCues = fallbackWords.map((word, index) => ({
        id: cueIdRef.current++, text: word,
        startSample: Math.round((merged.length * index) / Math.max(fallbackWords.length, 1)),
        endSample: Math.round((merged.length * (index + 1)) / Math.max(fallbackWords.length, 1)),
      }));
      transcriptRef.current = inputText;
      observedCuesRef.current = fallbackCues;
      cuesRef.current = fallbackCues;
      setTranscript(inputText);
      setCues(fallbackCues);
    }
    if (normalizeTranscriptTiming && cuesRef.current.length) {
      const normalizedCues = normalizeWordCueTiming(observedCuesRef.current, merged.length);
      cuesRef.current = normalizedCues;
      setCues(normalizedCues);
    }
    const url = URL.createObjectURL(pcmToWavBlob(merged));
    generatedPcmRef.current = merged;
    currentAudioUrlRef.current = url;
    setAudioUrl(url);
    setDuration(merged.length / SAMPLE_RATE);
    setWaveform(createWaveform(merged));
    setState("ready");
    setStatus("Voice ready");
    sessionRef.current?.close();
    sessionRef.current = null;
    const context = audioContextRef.current;
    const remainingMs = context ? Math.max(0, (nextStartRef.current - context.currentTime) * 1000) : 0;
    window.setTimeout(() => {
      setIsPlaying(false);
      setProgress(1);
    }, remainingMs + 40);
  }, [normalizeTranscriptTiming]);

  const generate = useCallback(async () => {
    const inputText = text.trim();
    if (!inputText || busy) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    await stopPlaybackInfrastructure();
    revokeAudioUrl();
    setState("connecting");
    setStatus("Opening a secure Gemini session…");
    setError(null);
    setTranscript("");
    transcriptRef.current = "";
    setCues([]);
    cuesRef.current = [];
    observedCuesRef.current = [];
    setActiveCue(-1);
    setProgress(0);
    setDuration(0);
    setIsPlaying(false);
    setWaveform(createWaveform(null));
    audioChunksRef.current = [];
    generatedPcmRef.current = null;
    audioSamplesRef.current = 0;
    cueEndSampleRef.current = 0;
    cueIdRef.current = 0;

    try {
      const tokenResponse = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText, voice }),
      });
      const tokenPayload = await tokenResponse.json() as {
        token?: string; model?: string; sessionConfig?: LiveConnectConfig; error?: string;
      };
      if (!tokenResponse.ok || !tokenPayload.token || !tokenPayload.model || !tokenPayload.sessionConfig) {
        throw new Error(tokenPayload.error || "Could not create a Gemini session.");
      }

      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const context = new AudioContextClass({ sampleRate: SAMPLE_RATE });
      await context.resume();
      if (generation !== generationRef.current) return;
      audioContextRef.current = context;
      nextStartRef.current = context.currentTime + 0.08;

      const ai = new GoogleGenAI({ apiKey: tokenPayload.token, httpOptions: { apiVersion: "v1alpha" } });
      const session = await ai.live.connect({
        model: tokenPayload.model,
        config: tokenPayload.sessionConfig,
        callbacks: {
          onopen: () => {
            if (generation !== generationRef.current) return;
            setState("generating");
            setStatus("Gemini is speaking");
            setIsPlaying(true);
          },
          onmessage: (message: LiveServerMessage) => {
            if (generation !== generationRef.current) return;
            const audioParts = message.serverContent?.modelTurn?.parts?.flatMap((part) =>
              part.inlineData?.data ? [part.inlineData.data] : [],
            ) ?? [];
            for (const data of audioParts) {
              const pcm = decodePcm(data);
              audioChunksRef.current.push(pcm);
              audioSamplesRef.current += pcm.length;
              scheduleAudio(pcm);
            }
            const fragment = message.serverContent?.outputTranscription?.text;
            if (fragment) addTranscriptFragment(fragment);
            if (message.serverContent?.turnComplete) finishGeneration(inputText);
          },
          onerror: (event) => {
            if (generation !== generationRef.current) return;
            setState("error");
            setError(event.message || "The Gemini audio connection was interrupted.");
            setStatus("Connection interrupted");
            setIsPlaying(false);
          },
          onclose: () => { /* turn completion owns the final state */ },
        },
      });
      sessionRef.current = session;
      session.sendClientContent({ turns: "Play", turnComplete: true });
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setState("error");
      setError(caught instanceof Error ? caught.message : "Something went wrong while generating speech.");
      setStatus("Generation failed");
      setIsPlaying(false);
    }
  }, [addTranscriptFragment, busy, finishGeneration, revokeAudioUrl, scheduleAudio, stopPlaybackInfrastructure, text, voice]);

  const togglePlayback = useCallback(async () => {
    if (busy && audioContextRef.current) {
      if (audioContextRef.current.state === "running") {
        await audioContextRef.current.suspend();
        setIsPlaying(false);
        setStatus("Paused");
      } else {
        await audioContextRef.current.resume();
        setIsPlaying(true);
        setStatus("Gemini is speaking");
      }
      return;
    }
    if (!audioUrl) return;
    if (audioElementRef.current && !audioElementRef.current.paused) {
      audioElementRef.current.pause();
      setIsPlaying(false);
      setStatus("Paused");
      return;
    }
    let audio = audioElementRef.current;
    if (!audio || audio.ended) {
      audio = new Audio(audioUrl);
      audioElementRef.current = audio;
      audio.playbackRate = speed;
      audio.onended = () => {
        setIsPlaying(false);
        setProgress(1);
        setStatus("Voice ready");
      };
    }
    await audio.play();
    setIsPlaying(true);
    setStatus("Playing your voice");
  }, [audioUrl, busy, speed]);

  const stop = useCallback(async () => {
    generationRef.current += 1;
    await stopPlaybackInfrastructure();
    setIsPlaying(false);
    setProgress(0);
    setActiveCue(-1);
    setState(audioUrl ? "ready" : "idle");
    setStatus(audioUrl ? "Voice ready" : "Ready when you are");
  }, [audioUrl, stopPlaybackInfrastructure]);

  const replay = useCallback(async () => {
    if (!audioUrl) return;
    audioElementRef.current?.pause();
    audioElementRef.current = null;
    setProgress(0);
    setActiveCue(-1);
    await togglePlayback();
  }, [audioUrl, togglePlayback]);

  const changeSpeed = useCallback((nextSpeed: number) => {
    setSpeed(nextSpeed);
    if (audioElementRef.current) audioElementRef.current.playbackRate = nextSpeed;
  }, []);

  const exportSyncedPackage = useCallback(async () => {
    const pcm = generatedPcmRef.current;
    const wordCues = cuesRef.current;
    if (!pcm?.length || !wordCues.length || isExporting) return;
    setIsExporting(true);
    try {
      const { default: JSZip } = await import("jszip");
      const captions = createCaptionCues(wordCues, captionWords, highlightDelayMs);
      const adjustedWordCues = wordCues.map((cue) => ({
        word: cue.text,
        startMs: Math.max(0, Math.round((cue.startSample / SAMPLE_RATE) * 1_000 + highlightDelayMs)),
        endMs: Math.max(80, Math.round((cue.endSample / SAMPLE_RATE) * 1_000 + highlightDelayMs)),
      }));
      const zip = new JSZip();
      zip.file("syncvoice.wav", pcmToWavBlob(pcm));
      zip.file("syncvoice.vtt", createWebVtt(captions));
      zip.file("syncvoice.srt", createSrt(captions));
      zip.file("syncvoice.json", JSON.stringify({
        format: "syncvoice-timed-audio",
        version: 1,
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        voice,
        sampleRate: SAMPLE_RATE,
        durationMs: Math.round(duration * 1_000),
        transcript,
        highlightDelayMs,
        words: adjustedWordCues,
        captions: captions.map((caption) => ({
          startMs: Math.round(caption.startSeconds * 1_000),
          endMs: Math.round(caption.endSeconds * 1_000),
          text: caption.text,
        })),
      }, null, 2));
      zip.file("README.txt", "SyncVoice synchronized media package\n\nUse syncvoice.wav as the audio track. Import syncvoice.vtt or syncvoice.srt as the matching subtitle/caption track in a compatible player or editor. syncvoice.json contains word-level millisecond timing for custom apps.\n");
      const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      downloadBlob(archive, "syncvoice-synced-media.zip");
    } finally {
      setIsExporting(false);
    }
  }, [captionWords, duration, highlightDelayMs, isExporting, transcript, voice]);

  useEffect(() => () => {
    generationRef.current += 1;
    void stopPlaybackInfrastructure();
    if (currentAudioUrlRef.current) URL.revokeObjectURL(currentAudioUrlRef.current);
  }, [stopPlaybackInfrastructure]);

  const elapsed = progress * duration;

  return (
    <main className="studio-shell">
      <nav className="topbar" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="SyncVoice home">
          <span className="brand-mark"><AudioLines size={20} strokeWidth={2.4} /></span>
          <span>SYNCVOICE</span>
        </a>
        <div className="model-pill"><span /> Gemini 2.5 Native Audio</div>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow"><Sparkles size={14} /> Natural speech. Precise timing.</div>
        <h1>Give your words<br /><em>a voice.</em></h1>
        <p>Create expressive speech with a transcript that follows every word, right on cue.</p>
      </section>

      <section className="workspace" aria-label="Text to speech studio">
        <div className="workspace-head">
          <div>
            <span className="section-kicker">01 / YOUR SCRIPT</span>
            <h2>What should we say?</h2>
          </div>
          <div className="script-stats">
            <span>{words} words</span><i />
            <span><Clock3 size={14} /> ≈ {formatTime(estimate)}</span>
          </div>
        </div>

        <div className="editor-wrap">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MAX_CHARACTERS))}
            aria-label="Text to convert to speech"
            placeholder="Paste or write something worth hearing…"
            disabled={busy}
          />
          <span className="character-count">{text.length.toLocaleString()} / {MAX_CHARACTERS.toLocaleString()}</span>
        </div>

        <div className="settings-row">
          <label className="voice-field">
            <span>VOICE</span>
            <div className="select-wrap">
              <select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={busy} aria-label="Voice">
                {VOICES.map((item) => <option value={item.id} key={item.id}>{item.label} — {item.note}</option>)}
              </select>
              <ChevronDown size={17} />
            </div>
          </label>

          <div className="voice-preview" aria-hidden="true">
            <span className="avatar-orbit"><span>{selectedVoice.label.slice(0, 1)}</span></span>
            <div><strong>{selectedVoice.label}</strong><small>{selectedVoice.note}</small></div>
          </div>

          <button className="generate-button" onClick={generate} disabled={busy || !text.trim()}>
            {busy ? <><span className="spinner" /> Generating</> : <><WandSparkles size={19} /> Generate voice</>}
          </button>
        </div>

        <button className="advanced-toggle" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen} aria-controls="advanced-settings">
          <span><Settings2 size={15} /> Advanced settings</span>
          <ChevronDown size={16} className={advancedOpen ? "open" : ""} />
        </button>

        {advancedOpen && (
          <div className="advanced-panel" id="advanced-settings">
            <div className="advanced-setting delay-setting">
              <div className="setting-copy">
                <strong>Transcript highlight delay</strong>
                <p>Move the active word earlier or later until it lands exactly on the voice.</p>
              </div>
              <div className="delay-control">
                <div className="delay-actions">
                  <button onClick={() => changeHighlightDelay(highlightDelayMs - 50)} aria-label="Move transcript highlight 50 milliseconds earlier"><Minus size={15} /></button>
                  <output aria-live="polite" className={highlightDelayMs === 0 ? "neutral" : ""}>{highlightDelayMs > 0 ? "+" : ""}{highlightDelayMs} ms</output>
                  <button onClick={() => changeHighlightDelay(highlightDelayMs + 50)} aria-label="Move transcript highlight 50 milliseconds later"><Plus size={15} /></button>
                </div>
                <input type="range" min="-2000" max="2000" step="25" value={highlightDelayMs} onChange={(event) => changeHighlightDelay(Number(event.target.value))} aria-label="Transcript highlight delay in milliseconds" />
                <div className="range-labels"><span>Earlier</span><button onClick={() => changeHighlightDelay(0)}>Reset</button><span>Later</span></div>
              </div>
            </div>

            <div className="advanced-setting">
              <div className="setting-copy">
                <strong>Normalize transcript timing</strong>
                <p>Evenly pace highlights across the completed audio. Off preserves Gemini's naturally observed, slightly live-feeling timing.</p>
              </div>
              <label className="timing-toggle"><input type="checkbox" checked={normalizeTranscriptTiming} onChange={(event) => changeNormalizeTranscriptTiming(event.target.checked)} disabled={busy} /><span>{normalizeTranscriptTiming ? "Normalized" : "Natural timing"}</span></label>
            </div>

            <div className="advanced-setting">
              <div className="setting-copy">
                <strong>Export caption grouping</strong>
                <p>Choose how many words appear together in WebVTT and SRT captions.</p>
              </div>
              <div className="caption-group-control">
                <input type="range" min="3" max="12" step="1" value={captionWords} onChange={(event) => setCaptionWords(Number(event.target.value))} aria-label="Words per exported caption" />
                <output>{captionWords} words</output>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className={`playback-panel ${busy ? "is-live" : ""}`} aria-live="polite">
        <div className="playback-head">
          <div>
            <span className="section-kicker">02 / PLAYBACK</span>
            <h2>{busy ? "Your voice is arriving" : audioUrl ? "Your voice is ready" : "Your voice will appear here"}</h2>
          </div>
          <div className={`status-chip ${state}`}>
            {state === "ready" ? <Check size={13} /> : <span />}{status}
          </div>
        </div>

        <div className="player-card">
          <button className="play-button" onClick={togglePlayback} disabled={!audioUrl && !busy} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <div className="waveform" aria-label={`Playback progress ${Math.round(progress * 100)} percent`}>
            {waveform.map((height, index) => (
              <span key={index} className={index / waveform.length <= progress ? "played" : ""} style={{ height: `${Math.round(height * 38)}px` }} />
            ))}
          </div>
          <div className="timecode"><span>{formatTime(elapsed)}</span><span>{formatTime(duration)}</span></div>
          <button className="icon-button" onClick={stop} disabled={!busy && !isPlaying} aria-label="Stop"><Square size={16} fill="currentColor" /></button>
          <button className="icon-button" onClick={replay} disabled={!audioUrl} aria-label="Replay"><RotateCcw size={17} /></button>
          {audioUrl ? <a className="icon-button" href={audioUrl} download="syncvoice.wav" aria-label="Download WAV"><Download size={17} /></a> : <span className="icon-button disabled"><Download size={17} /></span>}
        </div>

        <div className="player-meta">
          <div className="speed-control" aria-label="Playback speed">
            {[0.75, 1, 1.25].map((value) => <button key={value} onClick={() => changeSpeed(value)} className={speed === value ? "active" : ""}>{value}×</button>)}
          </div>
          <div className="export-meta">
            <span>24 kHz · PCM · WAV</span>
            <button className="export-button" onClick={exportSyncedPackage} disabled={!audioUrl || !cues.length || isExporting}>
              <FileArchive size={15} /> {isExporting ? "Packaging…" : "Export synced package"}
            </button>
          </div>
        </div>

        {audioUrl && <p className="export-note">Includes WAV audio, WebVTT and SRT captions, plus word-level JSON timing.</p>}

        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>

      <section className="transcript-section">
        <div className="transcript-head">
          <div>
            <span className="section-kicker">03 / SYNCED TRANSCRIPT</span>
            <h2>Follow every word.</h2>
          </div>
          <span className="sync-legend"><i /> Synced to audio</span>
        </div>
        <div className="transcript-card">
          {cues.length ? (
            <p>
              {cues.map((cue, index) => (
                <span key={cue.id} className={index === activeCue ? "active" : index < activeCue ? "spoken" : ""}>{cue.text}{" "}</span>
              ))}
            </p>
          ) : (
            <p className="transcript-placeholder">Your synchronized transcript will illuminate here as Gemini speaks.</p>
          )}
          <div className="transcript-foot">
            <span>{transcript ? `${transcript.split(/\s+/).filter(Boolean).length} transcribed words` : "Waiting for audio"}</span>
            <span>Word timing follows streamed PCM</span>
          </div>
        </div>
      </section>

      <footer>
        <span>SYNCVOICE</span>
        <p>Built for words worth hearing.</p>
        <small>Powered by Gemini native audio</small>
      </footer>
    </main>
  );
}
