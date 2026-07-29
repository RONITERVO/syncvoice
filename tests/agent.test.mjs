import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPrompt, modelForMode } from "../agent/contract.mjs";
import { characterCues, isPlausibleDuration, minimumPlausibleDurationMs, trimOuterSilence } from "../agent/generate.mjs";
import { TRIGGER_AUDIO_PCM, TRIGGER_SAMPLE_RATE } from "../agent/trigger-audio.mjs";
import { needsAudioWake } from "../agent/gemini-tts.mjs";

function syntheticWav(parts, sampleRate = 24_000) {
  const samples = [];
  for (const part of parts) {
    const count = Math.round(sampleRate * part.durationMs / 1_000);
    for (let index = 0; index < count; index += 1) samples.push(part.amplitude ? Math.round(part.amplitude * Math.sin(index / 8)) : 0);
  }
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples.length * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
  return wav;
}

test("routes inventory and implementation to the intended Codex tiers", () => {
  const previous = process.env.SYNCVOICE_CODEX_MODEL;
  delete process.env.SYNCVOICE_CODEX_MODEL;
  try {
    assert.equal(modelForMode("plan"), "gpt-5.6-terra");
    assert.equal(modelForMode("apply"), "gpt-5.6-sol");
  } finally {
    if (previous === undefined) delete process.env.SYNCVOICE_CODEX_MODEL;
    else process.env.SYNCVOICE_CODEX_MODEL = previous;
  }
});

test("ships a trimmed sub-second PCM wake-up recording", () => {
  assert.equal(TRIGGER_SAMPLE_RATE, 24_000);
  assert.ok(TRIGGER_AUDIO_PCM.length >= 1_000);
  assert.ok(TRIGGER_AUDIO_PCM.length / 2 / TRIGGER_SAMPLE_RATE < 0.75);
});

test("reserves the audio wake-up path for short utterances", () => {
  assert.equal(needsAudioWake("re"), true);
  assert.equal(needsAudioWake("sol sostenido"), true);
  assert.equal(needsAudioWake("aire seco y estable"), false);
});

test("keeps analysis read-only and apply scoped to the repository contract", () => {
  const plan = buildAgentPrompt({ mode: "plan", workspace: "C:\\game", mission: "Inventory speech" });
  const apply = buildAgentPrompt({ mode: "apply", workspace: "C:\\game", mission: "Integrate speech" });
  assert.match(plan, /ANALYZE: Read only/);
  assert.match(apply, /APPLY: You may make scoped changes/);
  assert.match(apply, /Do not expose credentials/);
  assert.match(apply, /\.syncvoice[\\/]project\.json/);
});

test("normalizes word timing into complete contiguous character cues", () => {
  const text = "Hola, mundo feliz.";
  const cues = characterCues(text, [
    { word: "Hola,", startMs: 0, endMs: 300 },
    { word: "mundo", startMs: 300, endMs: 700 },
    { word: "feliz.", startMs: 700, endMs: 1000 },
  ], 1000);
  assert.deepEqual(cues.map(({ startChar, endChar }) => [startChar, endChar]), [[0, 6], [6, 12], [12, text.length]]);
  assert.equal(cues.at(-1).endMs, 1000);
});

test("rejects transcript durations that cannot contain the requested speech", () => {
  assert.equal(minimumPlausibleDurationMs("reinterpretación"), 560);
  assert.equal(isPlausibleDuration("reinterpretación", 120), false);
  assert.equal(isPlausibleDuration("reinterpretación", 900), true);
  assert.equal(isPlausibleDuration("re", 120), false);
});

test("trims only the outer silence around an exact short utterance", () => {
  const wav = syntheticWav([
    { durationMs: 300, amplitude: 0 }, { durationMs: 650, amplitude: 9_000 }, { durationMs: 250, amplitude: 0 },
  ]);
  const take = trimOuterSilence(wav, "escuela");
  assert.ok(take);
  assert.ok(take.durationMs >= 790 && take.durationMs <= 830, `unexpected duration ${take.durationMs}`);
  assert.equal(take.wav.toString("ascii", 0, 4), "RIFF");
});

test("does not publish audio without a voiced utterance", () => {
  const wav = syntheticWav([{ durationMs: 900, amplitude: 0 }]);
  assert.equal(trimOuterSilence(wav, "escuela"), null);
});
