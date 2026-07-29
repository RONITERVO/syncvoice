import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the SyncVoice studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SyncVoice — TTS, in perfect time<\/title>/i);
  assert.match(html, /Give your words/);
  assert.match(html, /Generate voice/);
  assert.match(html, /Synced transcript/i);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps secrets server-side and removes the starter preview", async () => {
  const [client, route, packageJson] = await Promise.all([
    readFile(new URL("../app/tts-studio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(client, /GEMINI_API_KEY[1-4]/);
  assert.match(client, /fetch\("\/api\/session"/);
  assert.match(client, /Transcript highlight delay/);
  assert.match(client, /min="-2000" max="2000"/);
  assert.match(client, /createWebVtt/);
  assert.match(client, /createSrt/);
  assert.match(client, /Export synced package/);
  assert.match(route, /GEMINI_API_KEY\$\{index\}/);
  assert.match(route, /authTokens\.create/);
  assert.match(route, /gemini-2\.5-flash-native-audio-preview-12-2025/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"jszip"/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", templateRoot)));
});
