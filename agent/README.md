# SyncVoice Production Agent

The production agent has three separable responsibilities:

1. Codex inspects the selected Git repository in read-only mode and produces an inventory and plan.
2. With explicit Apply intent, Codex creates a deterministic extractor, `.syncvoice/project.json`, and the smallest runtime integration needed by that repository.
3. The resumable Gemini generator converts pending manifest entries into WAV files and word-level transcript JSON.

This separation lets teams review repository edits independently from expensive asset generation, resume large queues, regenerate only changed lines, and keep credentials out of the coding agent's environment.

Read-only inventory uses GPT-5.6 Terra for throughput; repository-changing work uses GPT-5.6 Sol for maximum implementation quality. `SYNCVOICE_CODEX_MODEL` can pin one model for both modes when a team needs a fixed evaluation baseline.

## Repository contract

`.syncvoice/project.json` is versioned and contains:

```json
{
  "version": 1,
  "project": {
    "id": "my-game",
    "name": "My Game",
    "sourceLocale": "en-US",
    "targetEngine": "custom"
  },
  "entries": [
    {
      "externalId": "quest.intro.guide.001",
      "scene": "quest.intro",
      "speaker": "Guide",
      "text": "Welcome, traveler.",
      "locale": "en-US",
      "voice": "Kore",
      "direction": "Warm, restrained welcome",
      "sourceFile": "locales/en/quest.json",
      "sourceKey": "quest.intro.guide.001"
    }
  ]
}
```

External IDs are permanent. Extraction must be deterministic and sorted. The generation hash includes model, text, locale, voice, and direction, so casting or script edits invalidate only affected assets.

## Security boundaries

- The companion binds only to `127.0.0.1` and requires a random pairing token.
- Cross-origin requests are restricted to localhost and Sites origins.
- Analyze runs in a read-only sandbox.
- Apply runs in a workspace-write sandbox and refuses uncommitted repositories by default.
- Codex network access and web search are disabled.
- The agent does not commit, push, or receive TTS credentials.

The companion's Generate job launches the deterministic Gemini runner outside the Codex process. Up to eight workers are distributed round-robin across the available keys, progress is streamed into the app, and `.syncvoice/generation-state.json` makes a stopped or restarted job resume only entries whose text/casting hash is still pending. The UI defaults to four workers; large offline runs can opt into eight after confirming their provider quota.

Large web projects can keep full-quality audio outside the application repository without losing resumability. `--locale` selects one or more locale shards and `--asset-root` routes their generated audio, transcripts, and runtime manifest to a companion repository or object-storage staging directory:

```sh
npm run agent:generate -- --manifest D:/game/.syncvoice/project.json --env D:/keys/.env --locale en-US,fi-FI --asset-root D:/game-audio/assets/syncvoice
```

The generation state remains beside the source manifest. Before skipping a completed entry, SyncVoice verifies that its expected audio and transcript files both exist under the active output root; moving to a new shard root therefore regenerates only assets absent from that root. Use a stable public asset origin in the game runtime. For GitHub Pages, keep every published application or companion asset repository comfortably below the platform's 1 GiB site limit; Git LFS objects are not served by Pages.

The Production agent panel exposes the same options as **Locales** and **Asset output folder**, so large-project sharding does not require a hand-written command.

Generation normally starts Gemini Live with a zero-audio text turn. The checked-in, half-second “Play” recording from MaestroTutor is reserved for one-to-three-word scripts, where the preview model can ignore text-only turns, and as a bounded fallback when a longer text-only turn returns no audio. For one-to-three-word lines, SyncVoice first requests the exact utterance once, rejects observed alphabetic transcripts that do not match, and uses waveform activity only to trim outer silence. If that attempt fails, it requests two newline-separated copies and publishes the first copy only when a deliberate internal silence proves the repetition boundary. Phrase-specific fallbacks add either a disposable neutral anchor before the target or a same-sentence educational continuation after an explicit long pause, and keep the target only when another deliberate silence proves the cut. No recovery path guesses from provisional output-transcription timestamps. Existing assets whose recorded duration is implausibly short for their text are automatically treated as pending, so interrupted or older projects repair only defective entries instead of regenerating the full library.
