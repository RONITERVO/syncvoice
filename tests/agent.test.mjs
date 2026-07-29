import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPrompt, modelForMode } from "../agent/contract.mjs";
import { characterCues } from "../agent/generate.mjs";

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
