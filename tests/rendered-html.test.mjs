import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

test("the root route renders the SyncVoice project workspace", async () => {
  const [page, layout, projectClient] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/project-studio.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<ProjectStudio \/>/);
  assert.match(layout, /SyncVoice — Game dialogue production/);
  assert.match(projectClient, /Loading workspace/);
  assert.match(projectClient, /Quick studio/);
  assert.doesNotMatch(`${page}${layout}${projectClient}`, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps credentials server-side and declares durable project infrastructure", async () => {
  const [quickClient, projectClient, sessionRoute, packageJson, schema, hosting, migration] = await Promise.all([
    readFile(new URL("../app/tts-studio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/project-studio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_rich_wild_child.sql", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(quickClient, /GEMINI_API_KEY[1-4]/);
  assert.match(quickClient, /fetch\("\/api\/session"/);
  assert.match(quickClient, /Transcript highlight delay/);
  assert.match(quickClient, /Normalize transcript timing/);
  assert.match(quickClient, /Export synced package/);
  assert.match(sessionRoute, /GEMINI_API_KEY\$\{index\}/);
  assert.match(sessionRoute, /authTokens\.create/);
  assert.match(sessionRoute, /gemini-2\.5-flash-native-audio-preview-12-2025/);
  assert.match(projectClient, /Generate pending/);
  assert.match(projectClient, /Resume/);
  assert.match(projectClient, /Build release/);
  assert.match(projectClient, /syncvoice-game-audio/);
  assert.match(projectClient, /Export project source/);
  assert.match(schema, /projectMembers/);
  assert.match(schema, /entries_project_external_idx/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "AUDIO"/);
  assert.match(migration, /CREATE TABLE `entries`/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"jszip"/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)));
});
