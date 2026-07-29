import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentPrompt, modelForMode } from "../agent/contract.mjs";
import { assetLocations, characterCues, extractAnchoredUtterance, extractFirstRepeatedUtterance, extractLeadingUtterance, isPlausibleDuration, minimumPlausibleDurationMs, readyInAssetRoot, selectedManifestEntries, shortTranscriptMatches, trimOuterSilence } from "../agent/generate.mjs";
import { normalizeManifestCues } from "../agent/normalize-cues.mjs";
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

test("preserves observed word timing in complete character cues", () => {
  const text = "Hola, mundo feliz.";
  const cues = characterCues(text, [
    { word: "Hola,", startMs: 0, endMs: 300 },
    { word: "mundo", startMs: 300, endMs: 700 },
    { word: "feliz.", startMs: 700, endMs: 1000 },
  ], 1000);
  assert.deepEqual(cues.map(({ startChar, endChar }) => [startChar, endChar]), [[0, 6], [6, 12], [12, text.length]]);
  assert.deepEqual(cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 300], [300, 700], [700, 1000]]);
  assert.equal(cues.at(-1).endMs, 1000);
});

test("normalizes word timing only when observed cues are omitted", () => {
  const cues = characterCues("uno dos tres", [], 1_000);
  assert.deepEqual(cues.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 333], [333, 667], [667, 1000]]);
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

test("validates observed alphabetic short transcripts without overreaching on numbers", () => {
  assert.equal(shortTranscriptMatches("kulttuurinen erottelu", "Kulttuurinen erottelu."), true);
  assert.equal(shortTranscriptMatches("kulttuurinen erottelu", "kulttuurinen ulottuvuus"), false);
  assert.equal(shortTranscriptMatches("9,58 UA", "nine point five eight AU"), true);
});

test("recovers the first copy only when a repeated short utterance has a proven pause", () => {
  const wav = syntheticWav([
    { durationMs: 200, amplitude: 0 }, { durationMs: 650, amplitude: 9_000 }, { durationMs: 300, amplitude: 0 },
    { durationMs: 650, amplitude: 9_000 }, { durationMs: 200, amplitude: 0 },
  ]);
  const take = extractFirstRepeatedUtterance(wav, "sexual reproduction");
  assert.ok(take);
  assert.ok(take.durationMs >= 790 && take.durationMs <= 830, `unexpected duration ${take.durationMs}`);
});

test("rejects repeated short audio without a safe internal pause", () => {
  const wav = syntheticWav([
    { durationMs: 200, amplitude: 0 }, { durationMs: 1_400, amplitude: 9_000 }, { durationMs: 200, amplitude: 0 },
  ]);
  assert.equal(extractFirstRepeatedUtterance(wav, "sexual reproduction"), null);
});

test("prefers the repetition midpoint over a longer pause between words", () => {
  const wav = syntheticWav([
    { durationMs: 150, amplitude: 0 },
    { durationMs: 300, amplitude: 9_000 }, { durationMs: 260, amplitude: 0 }, { durationMs: 300, amplitude: 9_000 },
    { durationMs: 200, amplitude: 0 },
    { durationMs: 300, amplitude: 9_000 }, { durationMs: 260, amplitude: 0 }, { durationMs: 300, amplitude: 9_000 },
    { durationMs: 150, amplitude: 0 },
  ]);
  const take = extractFirstRepeatedUtterance(wav, "kulttuurinen erottelu");
  assert.ok(take);
  assert.ok(take.durationMs >= 1_000, `unexpectedly kept only one word (${take.durationMs}ms)`);
});

test("removes a neutral anchor only when a safe pause precedes the target", () => {
  const wav = syntheticWav([
    { durationMs: 200, amplitude: 0 }, { durationMs: 400, amplitude: 9_000 }, { durationMs: 300, amplitude: 0 },
    { durationMs: 650, amplitude: 9_000 }, { durationMs: 200, amplitude: 0 },
  ]);
  const take = extractAnchoredUtterance(wav, "sexual reproduction");
  assert.ok(take);
  assert.ok(take.durationMs >= 790 && take.durationMs <= 830, `unexpected duration ${take.durationMs}`);
});

test("keeps a leading short target only when a safe context pause follows it", () => {
  const wav = syntheticWav([
    { durationMs: 200, amplitude: 0 }, { durationMs: 650, amplitude: 9_000 }, { durationMs: 350, amplitude: 0 },
    { durationMs: 1_600, amplitude: 9_000 }, { durationMs: 200, amplitude: 0 },
  ]);
  const take = extractLeadingUtterance(wav, "sexual reproduction");
  assert.ok(take);
  assert.ok(take.durationMs >= 790 && take.durationMs <= 830, `unexpected duration ${take.durationMs}`);
});

test("selects locale shards without changing manifest entry identity", () => {
  const entries = [
    { externalId: "es", locale: "es-ES" },
    { externalId: "en", locale: "en-US" },
    { externalId: "fi", locale: "fi-FI" },
  ];
  assert.equal(selectedManifestEntries(entries), entries);
  const selected = selectedManifestEntries(entries, "en-US,fi-FI");
  assert.deepEqual(selected, entries.slice(1));
  assert.strictEqual(selected[0], entries[1]);
  const finnish = selectedManifestEntries(entries, ["fi-FI"]);
  assert.deepEqual(finnish, [entries[2]]);
  assert.strictEqual(finnish[0], entries[2]);
});

test("resumes an entry only when both assets exist in the active output root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syncvoice-root-"));
  try {
    const entry = { externalId: "quest.intro", locale: "en-US", text: "Welcome home." };
    const hash = "casting-hash";
    const locations = assetLocations(entry, "mp3", true);
    const prior = { hash, ...locations, audio: locations.audioRelative, transcript: locations.transcriptRelative, durationMs: 1_200 };
    assert.equal(await readyInAssetRoot(entry, prior, hash, root, "mp3", true), false);
    await fs.mkdir(path.join(root, "audio"), { recursive: true });
    await fs.mkdir(path.join(root, "transcripts"), { recursive: true });
    await fs.writeFile(path.join(root, locations.audioRelative), "audio");
    await fs.writeFile(path.join(root, locations.transcriptRelative), "{}");
    assert.equal(await readyInAssetRoot(entry, prior, hash, root, "mp3", true), true);
    assert.equal(prior.assetRoot, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("normalizes an existing transcript without touching audio", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syncvoice-cues-"));
  try {
    const manifestPath = path.join(root, ".syncvoice", "project.json");
    const transcriptPath = path.join(root, "assets", "syncvoice", "transcripts", "line.json");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({
      project: { assetRoot: "assets/syncvoice", audioFormat: "mp3" },
      entries: [{ externalId: "line", locale: "en-US", text: "hello world" }],
    }));
    await fs.writeFile(transcriptPath, JSON.stringify({
      version: 1, externalId: "line", text: "hello world", durationMs: 1_000,
      cues: [{ startMs: 0, endMs: 100, startChar: 0, endChar: 6 }, { startMs: 100, endMs: 200, startChar: 6, endChar: 11 }],
    }));
    const result = await normalizeManifestCues({ manifestPath, locales: "en-US" });
    const transcript = JSON.parse(await fs.readFile(transcriptPath, "utf8"));
    assert.equal(result.changed, 1);
    assert.deepEqual(transcript.cues.map(cue => [cue.startMs, cue.endMs]), [[0, 500], [500, 1_000]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
