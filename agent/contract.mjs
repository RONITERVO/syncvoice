import path from "node:path";

export function modelForMode(mode) {
  return process.env.SYNCVOICE_CODEX_MODEL || (mode === "plan" ? "gpt-5.6-terra" : "gpt-5.6-sol");
}

export const resultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "completed", "needs_attention"] },
    summary: { type: "string" },
    entriesDiscovered: { type: "integer", minimum: 0 },
    filesChanged: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "entriesDiscovered", "filesChanged", "warnings", "nextActions"],
  additionalProperties: false,
};

export function buildAgentPrompt({ mode, workspace, mission }) {
  const contractPath = path.join(workspace, ".syncvoice", "project.json");
  const applying = mode === "apply";
  return `You are the SyncVoice Production Agent. Your job is to take ownership of voice-asset production so the game team can keep developing.

WORKSPACE
${workspace}

MISSION
${mission || "Discover every player-facing spoken line, prepare a durable SyncVoice asset manifest, and integrate generated audio plus synchronized transcript playback into this project."}

OPERATING MODE
${applying ? "APPLY: You may make scoped changes inside this repository." : "ANALYZE: Read only. Do not modify any file."}

PRODUCTION CONTRACT
- Inspect the repository and its existing narration, localization, content, build, and test conventions before deciding anything.
- Treat stable source identifiers as a permanent API. Derive them from existing localization keys or semantic source locations; never use array position alone when a stable key exists.
- Inventory all speech locales, speakers/roles, performance direction, and consuming runtime surfaces.
- Design for incremental regeneration: unchanged text and casting must keep the same ID and output path.
- The canonical repository manifest is ${contractPath}. It uses version 1 and contains project metadata plus an entries array.
- Every entry must contain: externalId, scene, speaker, text, locale, voice, direction. It may also contain sourceFile and sourceKey.
- Prefer a small deterministic extraction script over hand-maintaining thousands of generated manifest rows. The extraction script must write the canonical manifest atomically and in stable sorted order.
- Generated deliverables belong under assets/syncvoice unless the repository already has a stronger asset convention.
- Runtime integration must preserve current behavior and provide a graceful fallback when an audio asset is absent.
- Do not expose credentials, copy API keys into the repository, edit unrelated product behavior, rewrite existing source text, commit, push, open a PR, or access the network.
- Run the repository's relevant validation after applying changes. Do not claim validation you did not run.
${applying ? `
APPLY CHECKLIST
1. Create or update a deterministic SyncVoice extractor and ${contractPath}.
2. Add the smallest runtime adapter needed to play generated audio and synchronized transcripts without breaking existing fallback narration.
3. Add generated asset directories/state files to source control rules appropriately; manifests and integration code are tracked, transient checkpoints are ignored.
4. Document the exact refresh and generation workflow for the team.
5. Run focused validation and inspect the final diff.
` : `
ANALYSIS CHECKLIST
1. Count and classify the spoken inventory without materializing large generated files.
2. Identify the safest extraction boundary and runtime integration point.
3. Report concrete files that an Apply run would create or change.
`}

Return only the requested structured result. Keep the summary useful to a producer, and list risks honestly.`;
}

export function summarizeEvent(event) {
  if (event.type === "thread.started") return { type: "thread", message: "Codex thread started", threadId: event.thread_id };
  if (event.type === "turn.started") return { type: "status", message: "Repository work started" };
  if (event.type === "turn.completed") return { type: "status", message: "Repository work completed" };
  if (event.type === "turn.failed") return { type: "error", message: event.error?.message || "Codex turn failed" };
  if (event.type === "error") return { type: "error", message: event.message || "Codex agent error" };
  if (event.type !== "item.completed") return null;
  const item = event.item || {};
  if (item.type === "agent_message") return { type: "message", message: item.text || "Agent update" };
  if (item.type === "command_execution") return { type: "command", message: item.command || "Ran a repository command", status: item.status };
  if (item.type === "file_change") return { type: "file", message: "Updated repository files", changes: item.changes || [] };
  if (item.type === "reasoning") return { type: "thinking", message: item.text || "Reviewing repository" };
  return null;
}
