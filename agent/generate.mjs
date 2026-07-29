#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { generateSpeech, TTS_MODEL } from "./gemini-tts.mjs";

const execFileAsync = promisify(execFile);

function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2); const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? (index++, next) : true;
  }
  return args;
}
function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
function safePart(value) { const clean = String(value).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 90); return clean || crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16); }
function hashEntry(entry) { return crypto.createHash("sha256").update(JSON.stringify([TTS_MODEL, entry.text, entry.locale, entry.voice, entry.direction])).digest("hex"); }
async function writeJsonAtomic(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(temporary, file); }

export function selectedManifestEntries(entries, locales) {
  const requested = (Array.isArray(locales) ? locales : String(locales || "").split(","))
    .map(value => String(value).trim())
    .filter(Boolean);
  if (!requested.length) return entries;
  const allowed = new Set(requested);
  return entries.filter(entry => allowed.has(entry.locale));
}

export function assetLocations(entry, audioFormat, flatPaths) {
  const locale = safePart(entry.locale || "und");
  const id = safePart(entry.externalId);
  return {
    audioRelative: flatPaths ? `audio/${id}.${audioFormat}` : `audio/${locale}/${id}.${audioFormat}`,
    transcriptRelative: flatPaths ? `transcripts/${id}.json` : `transcripts/${locale}/${id}.json`,
  };
}

export async function readyInAssetRoot(entry, prior, hash, assetRoot, audioFormat, flatPaths) {
  if (!prior || prior.hash !== hash || !prior.audio || !prior.transcript || !isPlausibleDuration(entry.text, Number(prior.durationMs))) return false;
  const expected = assetLocations(entry, audioFormat, flatPaths);
  if (prior.audio !== expected.audioRelative || prior.transcript !== expected.transcriptRelative) return false;
  try {
    await Promise.all([
      fs.access(path.join(assetRoot, expected.audioRelative)),
      fs.access(path.join(assetRoot, expected.transcriptRelative)),
    ]);
    prior.assetRoot = assetRoot;
    return true;
  } catch {
    return false;
  }
}

export function minimumPlausibleDurationMs(text) {
  const words = String(text).trim().match(/\S+/g) || [];
  const spokenCharacters = String(text).replace(/\s+/g, "").length;
  return Math.max(250, words.length * 180, spokenCharacters * 35);
}

export function isPlausibleDuration(text, durationMs) {
  return Number.isFinite(durationMs) && durationMs >= minimumPlausibleDurationMs(text);
}

export function characterCues(text, wordCues, durationMs) {
  const words = [...text.matchAll(/\S+/g)];
  if (!words.length) return [{ startMs: 0, endMs: durationMs, startChar: 0, endChar: text.length }];
  const cues = words.map((match, index) => {
    const timed = wordCues.length === words.length ? wordCues[index] : null;
    return {
      startMs: timed ? Math.max(0, Math.min(durationMs, timed.startMs)) : Math.round(durationMs * index / words.length),
      endMs: timed ? Math.max(0, Math.min(durationMs, timed.endMs)) : Math.round(durationMs * (index + 1) / words.length),
      startChar: index === 0 ? 0 : match.index,
      endChar: index + 1 < words.length ? words[index + 1].index : text.length,
    };
  });
  return cues.map((cue, index) => ({ ...cue, startChar: index === 0 ? 0 : cues[index - 1].endChar, endMs: Math.max(cue.startMs, cue.endMs) }));
}

async function writeAudio(file, wav, format) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (format === "wav") { await fs.writeFile(file, wav); return; }
  if (format !== "mp3") throw new Error(`Unsupported audio format: ${format}`);
  const wavTemporary = `${file}.${process.pid}.partial.wav`;
  const audioTemporary = `${file}.${process.pid}.partial.mp3`;
  try {
    await fs.writeFile(wavTemporary, wav);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wavTemporary, "-codec:a", "libmp3lame", "-b:a", "96k", audioTemporary], { windowsHide: true });
    await fs.rename(audioTemporary, file);
  } finally {
    await Promise.all([fs.rm(wavTemporary, { force: true }), fs.rm(audioTemporary, { force: true })]);
  }
}

function readPcm16Wav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected a PCM WAV response from Gemini.");
  }
  let offset = 12; let format; let data;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8; const end = Math.min(wav.length, start + size);
    if (id === "fmt " && size >= 16) format = { encoding: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), sampleRate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14) };
    if (id === "data") data = { start, end };
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 || !format.sampleRate) {
    throw new Error("Expected mono 16-bit PCM WAV audio.");
  }
  const samples = new Int16Array(Math.floor((data.end - data.start) / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = wav.readInt16LE(data.start + index * 2);
  return { samples, sampleRate: format.sampleRate };
}

function wavFromPcm16(samples, sampleRate) {
  const wav = Buffer.allocUnsafe(44 + samples.length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples.length * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) wav.writeInt16LE(samples[index], 44 + index * 2);
  return wav;
}

export function trimOuterSilence(wav, text) {
  const { samples, sampleRate } = readPcm16Wav(wav);
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.01));
  const rms = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples); let energy = 0;
    for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
    rms.push(Math.sqrt(energy / Math.max(1, end - start)));
  }
  const peak = Math.max(0, ...rms);
  if (peak < 200) return null;
  const threshold = Math.max(180, peak * 0.08);
  const firstVoicedFrame = rms.findIndex(value => value >= threshold);
  let lastVoicedFrame = -1;
  for (let frame = rms.length - 1; frame >= 0; frame -= 1) {
    if (rms[frame] >= threshold) { lastVoicedFrame = frame; break; }
  }
  if (firstVoicedFrame < 0 || lastVoicedFrame < firstVoicedFrame) return null;
  const paddingSamples = Math.round(sampleRate * 0.08);
  const startSample = Math.max(0, firstVoicedFrame * frameSamples - paddingSamples);
  const endSample = Math.min(samples.length, (lastVoicedFrame + 1) * frameSamples + paddingSamples);
  const take = samples.slice(startSample, endSample);
  const durationMs = Math.round(take.length / sampleRate * 1_000);
  if (!isPlausibleDuration(text, durationMs)) return null;
  return { wav: wavFromPcm16(take, sampleRate), durationMs };
}

export async function generateEntrySpeech(entry, apiKey) {
  const generated = await generateSpeech(entry, apiKey);
  if (!isPlausibleDuration(entry.text, generated.durationMs)) throw new Error("Gemini returned implausibly short audio.");
  const words = entry.text.match(/\S+/g) || [];
  if (words.length > 3) return generated;
  const trimmed = trimOuterSilence(generated.wav, entry.text);
  if (!trimmed) throw new Error("Gemini audio did not contain a complete voiced utterance.");
  const cues = words.map((word, index) => ({
    word,
    startMs: Math.round(trimmed.durationMs * index / Math.max(1, words.length)),
    endMs: Math.round(trimmed.durationMs * (index + 1) / Math.max(1, words.length)),
  }));
  return { ...generated, ...trimmed, transcript: entry.text, cues };
}

async function acquireGenerationLock(root) {
  const lockPath = path.join(root, ".syncvoice", "generation.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return { handle, lockPath };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = await fs.readFile(lockPath, "utf8").catch(() => "another process");
    throw new Error(`A SyncVoice generation job is already active (${owner.trim()}).`);
  }
}

export async function generateManifest({ manifestPath, envPath, limit = Infinity, concurrency = 4, locales, assetRootOverride, signal, onProgress = console.log }) {
  const absoluteManifest = path.resolve(manifestPath);
  const root = path.resolve(path.dirname(absoluteManifest), "..");
  const lock = await acquireGenerationLock(root);
  try {
  const project = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  if (project.version !== 1 || !Array.isArray(project.entries)) throw new Error("Expected a SyncVoice version 1 manifest with an entries array.");
  const env = envPath ? parseEnv(await fs.readFile(path.resolve(envPath), "utf8")) : process.env;
  const keys = [1, 2, 3, 4].map((index) => env[`GEMINI_API_KEY${index}`] || process.env[`GEMINI_API_KEY${index}`]).filter(Boolean);
  if (!keys.length) throw new Error("No GEMINI_API_KEY1…4 values were found.");
  const assetRoot = path.resolve(root, assetRootOverride || project.project?.assetRoot || "assets/syncvoice");
  const audioFormat = String(project.project?.audioFormat || "wav").toLowerCase();
  const flatPaths = Boolean(assetRootOverride || project.project?.assetRoot);
  const statePath = path.join(root, ".syncvoice", "generation-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{\"version\":1,\"entries\":{}}"));
  state.version = 1; state.model = TTS_MODEL; state.entries ||= {};
  let checkpoint = Promise.resolve();
  const checkpointState = () => (checkpoint = checkpoint.then(() => writeJsonAtomic(statePath, state)));
  const selectedEntries = selectedManifestEntries(project.entries, locales);
  if (locales && !selectedEntries.length) throw new Error(`No manifest entries matched locale filter: ${String(locales)}`);
  const readiness = await Promise.all(selectedEntries.map(entry => {
    const hash = hashEntry(entry);
    return readyInAssetRoot(entry, state.entries[entry.externalId], hash, assetRoot, audioFormat, flatPaths);
  }));
  const pending = selectedEntries.filter((_, index) => !readiness[index]).slice(0, Number.isFinite(limit) ? limit : undefined);
  await checkpointState();
  let cursor = 0; let completed = 0; let failed = 0;

  async function worker(workerIndex) {
    while (cursor < pending.length) {
      if (signal?.aborted) return;
      const entry = pending[cursor++]; const hash = hashEntry(entry);
      const { audioRelative, transcriptRelative } = assetLocations(entry, audioFormat, flatPaths);
      const audioPath = path.join(assetRoot, audioRelative); const transcriptPath = path.join(assetRoot, transcriptRelative);
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if (signal?.aborted) break;
        try {
          const generated = await generateEntrySpeech(entry, keys[(workerIndex + attempt - 1) % keys.length]);
          await writeAudio(audioPath, generated.wav, audioFormat);
          await writeJsonAtomic(transcriptPath, { version: 1, externalId: entry.externalId, text: entry.text, durationMs: generated.durationMs, cues: characterCues(entry.text, generated.cues, generated.durationMs) });
          state.entries[entry.externalId] = { hash, assetRoot, audio: audioRelative.replaceAll("\\", "/"), transcript: transcriptRelative.replaceAll("\\", "/"), durationMs: generated.durationMs, generatedAt: new Date().toISOString() };
          completed += 1; await checkpointState(); onProgress({ type: "generated", completed, failed, total: pending.length, id: entry.externalId }); lastError = null; break;
        } catch (error) { lastError = error; if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000)); }
      }
      if (lastError) { failed += 1; state.entries[entry.externalId] = { hash, error: lastError instanceof Error ? lastError.message : String(lastError), failedAt: new Date().toISOString() }; await checkpointState(); onProgress({ type: "failed", completed, failed, total: pending.length, id: entry.externalId, error: state.entries[entry.externalId].error }); }
    }
  }
  await fs.mkdir(assetRoot, { recursive: true });
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, 8)) }, (_, index) => worker(index)));
  const runtimeEntries = (await Promise.all(selectedEntries.map(async entry => {
    const prior = state.entries[entry.externalId];
    return await readyInAssetRoot(entry, prior, hashEntry(entry), assetRoot, audioFormat, flatPaths)
      ? { ...entry, ...prior }
      : null;
  }))).filter(Boolean);
  await writeJsonAtomic(path.join(assetRoot, "manifest.json"), { version: 1, project: project.project, model: TTS_MODEL, generatedAt: new Date().toISOString(), entries: runtimeEntries });
  return { discovered: project.entries.length, selected: selectedEntries.length, pending: pending.length, completed, failed, ready: runtimeEntries.length, paused: Boolean(signal?.aborted), assetRoot };
  } finally {
    await lock.handle.close().catch(() => undefined);
    await fs.rm(lock.lockPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("generate.mjs")) {
  const args = argsOf(process.argv.slice(2));
  if (!args.manifest) { console.error("Usage: node agent/generate.mjs --manifest <.syncvoice/project.json> [--env <.env>] [--locale en-US,fi-FI] [--asset-root <path>] [--limit N] [--concurrency N]"); process.exit(2); }
  generateManifest({ manifestPath: args.manifest, envPath: args.env, locales: args.locale, assetRootOverride: args["asset-root"], limit: args.limit ? Number(args.limit) : Infinity, concurrency: args.concurrency ? Number(args.concurrency) : 4, onProgress: (event) => console.log(JSON.stringify(event)) })
    .then((result) => console.log(JSON.stringify({ type: "complete", ...result })))
    .catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });
}
