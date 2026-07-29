#!/usr/bin/env node
import { runProductionAgent } from "./runner.mjs";

const [mode, workspace, ...missionParts] = process.argv.slice(2);
if (!mode || !workspace || !new Set(["plan", "apply"]).has(mode)) {
  console.error("Usage: node agent/cli.mjs <plan|apply> <repository> [mission]");
  process.exit(2);
}

try {
  const output = await runProductionAgent({
    mode,
    workspace,
    mission: missionParts.join(" "),
    allowDirty: process.env.SYNCVOICE_ALLOW_DIRTY === "1",
    onEvent(event) {
      if (event.type === "thinking") return;
      console.error(`[${event.type}] ${event.message}`);
    },
  });
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
