import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Codex } from "@openai/codex-sdk";
import { buildAgentPrompt, modelForMode, resultSchema, summarizeEvent } from "./contract.mjs";

const execFileAsync = promisify(execFile);

export async function resolveWorkspace(input) {
  if (!input || typeof input !== "string") throw new Error("Choose a repository folder first.");
  const requested = path.resolve(input);
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("The repository folder does not exist.");
  const { stdout } = await execFileAsync("git", ["-C", requested, "rev-parse", "--show-toplevel"], { windowsHide: true });
  return path.resolve(stdout.trim());
}

export async function runProductionAgent({ mode, workspace, mission, allowDirty = false, signal, onEvent = () => {} }) {
  if (!new Set(["plan", "apply"]).has(mode)) throw new Error("Mode must be plan or apply.");
  const root = await resolveWorkspace(workspace);
  if (mode === "apply" && !allowDirty) {
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain"], { windowsHide: true });
    if (stdout.trim()) throw new Error("The repository has uncommitted changes. Commit/stash them, or explicitly allow a dirty workspace.");
  }

  const model = modelForMode(mode);
  const codex = new Codex();
  const thread = codex.startThread({
    model,
    modelReasoningEffort: mode === "apply" ? "high" : "medium",
    workingDirectory: root,
    sandboxMode: mode === "apply" ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
  });
  const streamed = await thread.runStreamed(buildAgentPrompt({ mode, workspace: root, mission }), { outputSchema: resultSchema, signal });
  let finalResponse = "";
  for await (const event of streamed.events) {
    const compact = summarizeEvent(event);
    if (compact) onEvent(compact);
    if (event.type === "item.completed" && event.item?.type === "agent_message") finalResponse = event.item.text || finalResponse;
  }
  let result;
  try { result = JSON.parse(finalResponse); }
  catch { throw new Error(finalResponse || "Codex finished without a structured production report."); }
  return { id: crypto.randomUUID(), threadId: thread.id, workspace: root, model, result };
}
