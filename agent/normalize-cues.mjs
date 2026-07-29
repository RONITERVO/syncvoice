#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetLocations, characterCues, selectedManifestEntries } from "./generate.mjs";

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

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

export async function normalizeManifestCues({ manifestPath, assetRootOverride, locales }) {
  const absoluteManifest = path.resolve(manifestPath);
  const repositoryRoot = path.resolve(path.dirname(absoluteManifest), "..");
  const project = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
  const assetRoot = path.resolve(repositoryRoot, assetRootOverride || project.project?.assetRoot || "assets/syncvoice");
  const audioFormat = String(project.project?.audioFormat || "wav").toLowerCase();
  const flatPaths = Boolean(assetRootOverride || project.project?.assetRoot);
  const entries = selectedManifestEntries(project.entries, locales);
  let changed = 0;

  for (const entry of entries) {
    const { transcriptRelative } = assetLocations(entry, audioFormat, flatPaths);
    const transcriptPath = path.join(assetRoot, transcriptRelative);
    const transcript = JSON.parse(await fs.readFile(transcriptPath, "utf8"));
    if (transcript.externalId !== entry.externalId || transcript.text !== entry.text || !Number.isFinite(transcript.durationMs) || transcript.durationMs <= 0) {
      throw new Error(`${entry.externalId}: transcript identity or duration is invalid.`);
    }
    const cues = characterCues(entry.text, [], transcript.durationMs);
    if (JSON.stringify(transcript.cues) === JSON.stringify(cues)) continue;
    await writeJsonAtomic(transcriptPath, { ...transcript, cues });
    changed += 1;
  }
  return { selected: entries.length, changed, assetRoot };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = argsOf(process.argv.slice(2));
  if (!args.manifest) {
    console.error("Usage: node agent/normalize-cues.mjs --manifest <.syncvoice/project.json> [--asset-root <path>] [--locale en-US,fi-FI]");
    process.exit(2);
  }
  normalizeManifestCues({ manifestPath: args.manifest, assetRootOverride: args["asset-root"], locales: args.locale })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });
}
