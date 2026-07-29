import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import type { TimedWord } from "@/lib/project-types";

const SAMPLE_RATE = 24_000;

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
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

function pcmToWavBlob(pcm: Int16Array) {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return new Blob([buffer], { type: "audio/wav" });
}

function appendTranscript(previous: string, fragment: string) {
  const normalized = fragment.replace(/\s+/g, " ").trim();
  if (!normalized) return previous;
  if (!previous) return normalized;
  return /^[,.;:!?)}\]]/.test(normalized) ? `${previous}${normalized}` : `${previous} ${normalized}`;
}

export type GeneratedDialogueAudio = {
  wav: Blob;
  transcript: string;
  cues: TimedWord[];
  durationMs: number;
};

export async function generateDialogueAudio(options: {
  text: string;
  voice: string;
  direction?: string;
  locale?: string;
  signal?: AbortSignal;
  onProgress?: (receivedSeconds: number) => void;
}): Promise<GeneratedDialogueAudio> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: options.text, voice: options.voice, direction: options.direction, locale: options.locale }),
    signal: options.signal,
  });
  const payload = await response.json() as { token?: string; model?: string; sessionConfig?: LiveConnectConfig; error?: string };
  if (!response.ok || !payload.token || !payload.model || !payload.sessionConfig) {
    throw new Error(payload.error || "Could not create an audio session.");
  }
  const token = payload.token;
  const model = payload.model;
  const sessionConfig = payload.sessionConfig;

  return new Promise<GeneratedDialogueAudio>(async (resolve, reject) => {
    let session: Session | null = null;
    let settled = false;
    const chunks: Int16Array[] = [];
    const cues: TimedWord[] = [];
    let transcript = "";
    let totalSamples = 0;
    let cueEndSample = 0;
    const timeout = window.setTimeout(() => finishError(new Error("Audio generation timed out.")), 180_000);

    function cleanup() {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      try { session?.close(); } catch { /* already closed */ }
    }

    function finishError(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function handleAbort() {
      finishError(new DOMException("Generation paused.", "AbortError"));
    }

    function addTranscript(fragment: string) {
      const normalized = fragment.replace(/\s+/g, " ").trim();
      if (!normalized) return;
      transcript = appendTranscript(transcript, normalized);
      const words = normalized.match(/\S+/g) ?? [];
      if (!words.length) return;
      const startSample = cueEndSample;
      const endSample = Math.max(totalSamples, startSample + words.length * 1_800);
      const span = endSample - startSample;
      for (let index = 0; index < words.length; index += 1) {
        cues.push({
          word: words[index],
          startMs: Math.round(((startSample + (span * index) / words.length) / SAMPLE_RATE) * 1_000),
          endMs: Math.round(((startSample + (span * (index + 1)) / words.length) / SAMPLE_RATE) * 1_000),
        });
      }
      cueEndSample = endSample;
    }

    function finishSuccess() {
      if (settled) return;
      const pcm = mergePcm(chunks);
      if (!pcm.length) return finishError(new Error("Gemini completed without returning audio."));
      if (!cues.length) {
        const fallbackWords = options.text.match(/\S+/g) ?? [];
        for (let index = 0; index < fallbackWords.length; index += 1) {
          cues.push({
            word: fallbackWords[index],
            startMs: Math.round((pcm.length * index / Math.max(1, fallbackWords.length) / SAMPLE_RATE) * 1_000),
            endMs: Math.round((pcm.length * (index + 1) / Math.max(1, fallbackWords.length) / SAMPLE_RATE) * 1_000),
          });
        }
        transcript = options.text;
      }
      settled = true;
      cleanup();
      resolve({ wav: pcmToWavBlob(pcm), transcript, cues, durationMs: Math.round((pcm.length / SAMPLE_RATE) * 1_000) });
    }

    if (options.signal?.aborted) return handleAbort();
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      session = await ai.live.connect({
        model,
        config: sessionConfig,
        callbacks: {
          onopen: () => undefined,
          onmessage: (message: LiveServerMessage) => {
            const parts = message.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (!part.inlineData?.data) continue;
              const pcm = decodePcm(part.inlineData.data);
              chunks.push(pcm);
              totalSamples += pcm.length;
              options.onProgress?.(totalSamples / SAMPLE_RATE);
            }
            const fragment = message.serverContent?.outputTranscription?.text;
            if (fragment) addTranscript(fragment);
            if (message.serverContent?.turnComplete) finishSuccess();
          },
          onerror: (event) => finishError(new Error(event.message || "Gemini audio connection failed.")),
          onclose: () => undefined,
        },
      });
      session.sendClientContent({ turns: "Play", turnComplete: true });
    } catch (caught) {
      finishError(caught instanceof Error ? caught : new Error("Audio generation failed."));
    }
  });
}
