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

function trimWav(wav, durationMs) {
  const requestedBytes = Math.max(2, Math.floor(durationMs * 24_000 / 1_000) * 2);
  const availableBytes = Math.max(0, wav.length - 44);
  const dataBytes = Math.min(availableBytes, requestedBytes);
  const trimmed = Buffer.from(wav.subarray(0, 44 + dataBytes));
  trimmed.writeUInt32LE(36 + dataBytes, 4);
  trimmed.writeUInt32LE(dataBytes, 40);
  return trimmed;
}

async function generateEntrySpeech(entry, apiKey) {
  try { return await generateSpeech(entry, apiKey); }
  catch (error) {
    if (!/without returning audio/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const originalWordCount = entry.text.match(/\S+/g)?.length || 1;
    const base = entry.text.trim().replace(/[.!?…:]+$/, "");
    const padded = await generateSpeech({ ...entry, text: `${base}. ${base}.` }, apiKey);
    if (padded.cues.length <= originalWordCount) return { ...padded, transcript: entry.text };
    const durationMs = Math.max(120, padded.cues[originalWordCount - 1].endMs);
    return { ...padded, wav: trimWav(padded.wav, durationMs), durationMs, cues: padded.cues.slice(0, originalWordCount), transcript: entry.text };
  }
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

export async function generateManifest({ manifestPath, envPath, limit = Infinity, concurrency = 4, signal, onProgress = console.log }) {
  const absoluteManifest = path.resolve(manifestPath);
  const root = path.resolve(path.dirname(absoluteManifest), "..");
  const lock = await acquireGenerationLock(root);
  try {
  const project = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  if (project.version !== 1 || !Array.isArray(project.entries)) throw new Error("Expected a SyncVoice version 1 manifest with an entries array.");
  const env = envPath ? parseEnv(await fs.readFile(path.resolve(envPath), "utf8")) : process.env;
  const keys = [1, 2, 3, 4].map((index) => env[`GEMINI_API_KEY${index}`] || process.env[`GEMINI_API_KEY${index}`]).filter(Boolean);
  if (!keys.length) throw new Error("No GEMINI_API_KEY1…4 values were found.");
  const assetRoot = path.resolve(root, project.project?.assetRoot || "assets/syncvoice");
  const audioFormat = String(project.project?.audioFormat || "wav").toLowerCase();
  const statePath = path.join(root, ".syncvoice", "generation-state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{\"version\":1,\"entries\":{}}"));
  state.version = 1; state.model = TTS_MODEL; state.entries ||= {};
  let checkpoint = Promise.resolve();
  const checkpointState = () => (checkpoint = checkpoint.then(() => writeJsonAtomic(statePath, state)));
  const pending = project.entries.filter((entry) => {
    const hash = hashEntry(entry); const prior = state.entries[entry.externalId];
    return !prior || prior.hash !== hash || !prior.audio;
  }).slice(0, Number.isFinite(limit) ? limit : undefined);
  let cursor = 0; let completed = 0; let failed = 0;

  async function worker(workerIndex) {
    while (cursor < pending.length) {
      if (signal?.aborted) return;
      const entry = pending[cursor++]; const hash = hashEntry(entry); const locale = safePart(entry.locale || "und"); const id = safePart(entry.externalId);
      const flatPaths = Boolean(project.project?.assetRoot);
      const audioRelative = flatPaths ? `audio/${id}.${audioFormat}` : `audio/${locale}/${id}.${audioFormat}`;
      const transcriptRelative = flatPaths ? `transcripts/${id}.json` : `transcripts/${locale}/${id}.json`;
      const audioPath = path.join(assetRoot, audioRelative); const transcriptPath = path.join(assetRoot, transcriptRelative);
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if (signal?.aborted) break;
        try {
          const generated = await generateEntrySpeech(entry, keys[(workerIndex + attempt - 1) % keys.length]);
          await writeAudio(audioPath, generated.wav, audioFormat);
          await writeJsonAtomic(transcriptPath, { version: 1, externalId: entry.externalId, text: entry.text, durationMs: generated.durationMs, cues: characterCues(entry.text, generated.cues, generated.durationMs) });
          state.entries[entry.externalId] = { hash, audio: audioRelative.replaceAll("\\", "/"), transcript: transcriptRelative.replaceAll("\\", "/"), durationMs: generated.durationMs, generatedAt: new Date().toISOString() };
          completed += 1; await checkpointState(); onProgress({ type: "generated", completed, failed, total: pending.length, id: entry.externalId }); lastError = null; break;
        } catch (error) { lastError = error; if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000)); }
      }
      if (lastError) { failed += 1; state.entries[entry.externalId] = { hash, error: lastError instanceof Error ? lastError.message : String(lastError), failedAt: new Date().toISOString() }; await checkpointState(); onProgress({ type: "failed", completed, failed, total: pending.length, id: entry.externalId, error: state.entries[entry.externalId].error }); }
    }
  }
  await fs.mkdir(assetRoot, { recursive: true });
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, keys.length, 8)) }, (_, index) => worker(index)));
  const runtimeEntries = project.entries.map((entry) => ({ ...entry, ...(state.entries[entry.externalId] || {}) })).filter((entry) => entry.audio);
  await writeJsonAtomic(path.join(assetRoot, "manifest.json"), { version: 1, project: project.project, model: TTS_MODEL, generatedAt: new Date().toISOString(), entries: runtimeEntries });
  return { discovered: project.entries.length, pending: pending.length, completed, failed, ready: runtimeEntries.length, paused: Boolean(signal?.aborted), assetRoot };
  } finally {
    await lock.handle.close().catch(() => undefined);
    await fs.rm(lock.lockPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1]?.endsWith("generate.mjs")) {
  const args = argsOf(process.argv.slice(2));
  if (!args.manifest) { console.error("Usage: node agent/generate.mjs --manifest <.syncvoice/project.json> [--env <.env>] [--limit N] [--concurrency N]"); process.exit(2); }
  generateManifest({ manifestPath: args.manifest, envPath: args.env, limit: args.limit ? Number(args.limit) : Infinity, concurrency: args.concurrency ? Number(args.concurrency) : 4, onProgress: (event) => console.log(JSON.stringify(event)) })
    .then((result) => console.log(JSON.stringify({ type: "complete", ...result })))
    .catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });
}
