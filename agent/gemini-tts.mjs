import { GoogleGenAI, Modality } from "@google/genai";
import { TRIGGER_AUDIO_PCM, TRIGGER_SAMPLE_RATE } from "./trigger-audio.mjs";

export const TTS_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
export const SAMPLE_RATE = 24_000;
const TRIGGER_CHUNK_MS = 100;
const MAX_TRIGGER_MS = 10_000;
const TEXT_WAKE_FALLBACK_MS = 4_000;

export function needsAudioWake(text) {
  return (String(text).trim().match(/\S+/g) || []).length <= 3;
}

function instruction(entry, repeatShort = false, anchorShort = false, contextShort = false) {
  const spokenText = /[.!?…:]$/.test(entry.text.trim()) ? entry.text : `${entry.text}.`;
  const contextTarget = entry.text.trim().replace(/[.!?…:;]+$/u, "");
  const script = contextShort ? `${contextTarget} — an educational science term used in this school lesson.` : anchorShort ? `Ready.\n\n${spokenText}` : repeatShort ? `${spokenText}\n\n${spokenText}` : spokenText;
  return `You are a professional text-to-speech engine. Read the SCRIPT below aloud exactly as written.

Rules:
- Begin speaking immediately when the user says "Play".
- Preserve the wording, order, language, punctuation, and intent.
- Speak naturally and clearly, with expressive but restrained delivery.
- The script may contain only one short word. Always speak it once.
${repeatShort ? "- Recovery mode: the same short script appears twice. Speak both copies, with a clear pause between the two lines." : ""}
${anchorShort ? "- Anchored recovery mode: speak the neutral first line, pause clearly, then speak the second line exactly." : ""}
${contextShort ? "- Context recovery mode: make a clear half-second pause at the em dash; do not speak the punctuation name." : ""}
- Do not add an introduction, acknowledgement, explanation, or closing.
- Do not describe these instructions.
${entry.direction ? `- Delivery direction (do not speak this): ${entry.direction}` : ""}
${entry.locale ? `- Intended locale: ${entry.locale}` : ""}

SCRIPT:
${script}`;
}

function appendTranscript(previous, fragment) {
  const normalized = fragment.replace(/\s+/g, " ").trim();
  if (!normalized) return previous;
  if (!previous) return normalized;
  return /^[,.;:!?)}\]]/.test(normalized) ? `${previous}${normalized}` : `${previous} ${normalized}`;
}

function wavBuffer(pcm) {
  const buffer = Buffer.allocUnsafe(44 + pcm.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + pcm.length * 2, 4); buffer.write("WAVE", 8); buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(pcm.length * 2, 40);
  for (let index = 0; index < pcm.length; index += 1) buffer.writeInt16LE(pcm[index], 44 + index * 2);
  return buffer;
}

export async function generateSpeech(entry, apiKey, { timeoutMs = 180_000, repeatShort = false, anchorShort = false, contextShort = false } = {}) {
  const chunks = [];
  const cues = [];
  let transcript = "";
  let totalSamples = 0;
  let cueEndSample = 0;
  let session;
  let triggerCancelled = false;
  let triggerStarted = false;
  let textWakeFallback;
  let wakeMode = "text";
  let noAudioTurnCompletions = 0;
  let transcriptObserved = false;

  return new Promise(async (resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finishError(new Error("Audio generation timed out.")), timeoutMs);
    function cleanup() { clearTimeout(timeout); clearTimeout(textWakeFallback); triggerCancelled = true; try { session?.close(); } catch {} }
    function finishError(error) { if (settled) return; settled = true; cleanup(); reject(error); }
    function addTranscript(fragment) {
      const normalized = fragment.replace(/\s+/g, " ").trim();
      if (!normalized) return;
      transcriptObserved = true;
      transcript = appendTranscript(transcript, normalized);
      const words = normalized.match(/\S+/g) || [];
      const startSample = cueEndSample;
      const endSample = Math.max(totalSamples, startSample + words.length * 1_800);
      const span = endSample - startSample;
      words.forEach((word, index) => cues.push({ word, startMs: Math.round(((startSample + span * index / words.length) / SAMPLE_RATE) * 1_000), endMs: Math.round(((startSample + span * (index + 1) / words.length) / SAMPLE_RATE) * 1_000) }));
      cueEndSample = endSample;
    }
    function finishSuccess() {
      if (settled) return;
      const pcm = new Int16Array(totalSamples);
      let offset = 0; for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
      if (!pcm.length) return finishError(new Error("Gemini completed without returning audio."));
      if (!cues.length) {
        const words = entry.text.match(/\S+/g) || [];
        words.forEach((word, index) => cues.push({ word, startMs: Math.round(pcm.length * index / Math.max(1, words.length) / SAMPLE_RATE * 1_000), endMs: Math.round(pcm.length * (index + 1) / Math.max(1, words.length) / SAMPLE_RATE * 1_000) }));
        transcript = entry.text;
      }
      settled = true; cleanup();
      resolve({ wav: wavBuffer(pcm), transcript, transcriptObserved, cues, durationMs: Math.round(pcm.length / SAMPLE_RATE * 1_000), wakeMode });
    }
    function startAudioWake(isFallback = false) {
      if (settled || triggerStarted) return;
      triggerStarted = true;
      clearTimeout(textWakeFallback);
      wakeMode = isFallback ? "audio-fallback" : "audio";
      if (isFallback && !totalSamples) { transcript = ""; cues.length = 0; cueEndSample = 0; }
      const chunkBytes = Math.floor(TRIGGER_SAMPLE_RATE * TRIGGER_CHUNK_MS / 1_000) * 2;
      void (async () => {
        const startedAt = Date.now(); let offset = 0;
        while (!triggerCancelled && Date.now() - startedAt < MAX_TRIGGER_MS) {
          const chunk = offset < TRIGGER_AUDIO_PCM.length
            ? TRIGGER_AUDIO_PCM.subarray(offset, Math.min(TRIGGER_AUDIO_PCM.length, offset + chunkBytes))
            : Buffer.alloc(chunkBytes);
          offset += chunk.length;
          session.sendRealtimeInput({ audio: { mimeType: `audio/pcm;rate=${TRIGGER_SAMPLE_RATE}`, data: chunk.toString("base64") } });
          await new Promise(resolveDelay => setTimeout(resolveDelay, TRIGGER_CHUNK_MS));
        }
      })().catch(error => finishError(error instanceof Error ? error : new Error(String(error))));
    }
    try {
      const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
      session = await ai.live.connect({
        model: TTS_MODEL,
        config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: entry.voice || "Kore" } } }, systemInstruction: { parts: [{ text: instruction(entry, repeatShort, anchorShort, contextShort) }] }, outputAudioTranscription: {}, thinkingConfig: { thinkingBudget: 0 } },
        callbacks: {
          onopen: () => undefined,
          onmessage(message) {
            for (const part of message.serverContent?.modelTurn?.parts || []) {
              if (!part.inlineData?.data) continue;
              const bytes = Buffer.from(part.inlineData.data, "base64");
              const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)).slice();
              chunks.push(pcm); totalSamples += pcm.length;
              clearTimeout(textWakeFallback);
            }
            const fragment = message.serverContent?.outputTranscription?.text;
            if (fragment) addTranscript(fragment);
            if (message.serverContent?.turnComplete) {
              if (!totalSamples) {
                noAudioTurnCompletions += 1;
                if (!triggerStarted) startAudioWake(true);
                else if (wakeMode === "audio" || noAudioTurnCompletions > 1) finishSuccess();
              } else finishSuccess();
            }
          },
          onerror: (event) => finishError(new Error(event.message || "Gemini audio connection failed.")),
          onclose: () => undefined,
        },
      });
      if (needsAudioWake(entry.text)) startAudioWake();
      else {
        session.sendClientContent({ turns: "Play the script now.", turnComplete: true });
        textWakeFallback = setTimeout(() => startAudioWake(true), TEXT_WAKE_FALLBACK_MS);
      }
    } catch (error) { finishError(error instanceof Error ? error : new Error(String(error))); }
  });
}
