#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { generateManifest } from "./generate.mjs";
import { resolveWorkspace, runProductionAgent } from "./runner.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SYNCVOICE_AGENT_PORT || 4319);
const TOKEN = process.env.SYNCVOICE_AGENT_TOKEN || crypto.randomBytes(24).toString("base64url");
const jobs = new Map();

function allowedOrigin(origin) {
  if (!origin) return "*";
  try {
    const url = new URL(origin);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return origin;
    if (url.protocol === "https:" && url.hostname.endsWith(".chatgpt.site")) return origin;
  } catch {}
  return null;
}

function headersFor(request) {
  const origin = allowedOrigin(request.headers.origin);
  return {
    "access-control-allow-origin": origin || "null",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function send(request, response, status, body) {
  response.writeHead(status, { ...headersFor(request), "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function publicJob(job) {
  return { id: job.id, status: job.status, mode: job.mode, workspace: job.workspace, createdAt: job.createdAt, updatedAt: job.updatedAt, events: job.events.slice(-120), output: job.output, error: job.error };
}

async function startJob(job) {
  job.status = "running";
  try {
    const onEvent = (event) => { job.events.push({ ...event, at: Date.now() }); job.updatedAt = Date.now(); };
    if (job.mode === "generate") {
      const root = await resolveWorkspace(job.workspace);
      const generated = await generateManifest({
        manifestPath: path.join(root, ".syncvoice", "project.json"), envPath: job.envPath,
        concurrency: job.concurrency, signal: job.controller.signal,
        onProgress(event) { onEvent({ type: event.type, message: event.type === "generated" ? `Generated ${event.completed} of ${event.total}: ${event.id}` : `Could not generate ${event.id}: ${event.error || "unknown error"}` }); },
      });
      job.output = { workspace: root, result: { status: generated.paused ? "needs_attention" : generated.failed ? "needs_attention" : "completed", summary: generated.paused ? `Generation paused safely with ${generated.ready.toLocaleString()} assets ready.` : `Generation finished with ${generated.ready.toLocaleString()} assets ready and ${generated.failed.toLocaleString()} failures.`, entriesDiscovered: generated.discovered, filesChanged: ["assets/syncvoice/audio", "assets/syncvoice/transcripts", "assets/syncvoice/manifest.json"], warnings: generated.failed ? [`${generated.failed} entries need retry.`] : [], nextActions: generated.paused ? ["Start Generate assets again to resume pending entries."] : ["Run the repository asset-completeness validator."] } };
      job.status = generated.paused ? "cancelled" : "completed";
    } else {
      job.output = await runProductionAgent({ mode: job.mode, workspace: job.workspace, mission: job.mission, allowDirty: job.allowDirty, signal: job.controller.signal, onEvent });
      job.status = job.controller.signal.aborted ? "cancelled" : "completed";
    }
  } catch (error) {
    if (job.controller.signal.aborted) { job.status = "cancelled"; job.error = null; job.updatedAt = Date.now(); return; }
    job.error = error instanceof Error ? error.message : String(error);
    job.events.push({ type: "error", message: job.error, at: Date.now() });
    job.status = "failed";
  }
  job.updatedAt = Date.now();
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, headersFor(request)); response.end(); return; }
  if (!allowedOrigin(request.headers.origin)) return send(request, response, 403, { error: "Origin is not allowed." });
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(request, response, 401, { error: "Pairing token is invalid." });
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (request.method === "GET" && url.pathname === "/health") return send(request, response, 200, { ok: true, service: "SyncVoice Codex Companion" });
  if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const job = jobs.get(url.pathname.slice(6));
    return job ? send(request, response, 200, publicJob(job)) : send(request, response, 404, { error: "Job not found." });
  }
  if (request.method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
    const job = jobs.get(url.pathname.split("/")[2]);
    if (!job) return send(request, response, 404, { error: "Job not found." });
    job.controller.abort(); job.events.push({ type: "status", message: "Safe pause requested; active work will finish first.", at: Date.now() });
    return send(request, response, 202, publicJob(job));
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    try {
      const body = await readJson(request);
      if (!new Set(["plan", "apply", "generate"]).has(body.mode)) return send(request, response, 400, { error: "Mode must be plan, apply, or generate." });
      const now = Date.now();
      const job = { id: crypto.randomUUID(), status: "queued", mode: body.mode, workspace: String(body.workspace || ""), mission: String(body.mission || "").slice(0, 8_000), envPath: String(body.envPath || ""), concurrency: Math.max(1, Math.min(4, Number(body.concurrency) || 4)), allowDirty: body.allowDirty === true, controller: new AbortController(), createdAt: now, updatedAt: now, events: [], output: null, error: null };
      jobs.set(job.id, job);
      void startJob(job);
      return send(request, response, 202, publicJob(job));
    } catch (error) { return send(request, response, 400, { error: error instanceof Error ? error.message : "Invalid request." }); }
  }
  return send(request, response, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`SyncVoice Codex Companion: http://${HOST}:${PORT}`);
  console.log(`Pairing token: ${TOKEN}`);
  console.log("Keep this window open while the Production Agent is working.");
});
