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

The companion's Generate job launches the deterministic Gemini runner outside the Codex process. Four keys may work concurrently, progress is streamed into the app, and `.syncvoice/generation-state.json` makes a stopped or restarted job resume only entries whose text/casting hash is still pending.

Generation wakes the Gemini Live model with the same checked-in, sub-second “Play” recording used by MaestroTutor instead of relying on a text turn that the preview model can ignore for short scripts. For one-to-three-word lines, SyncVoice requests the exact utterance once and uses waveform activity only to trim outer silence; it never guesses an internal cut from provisional output-transcription timestamps. Existing assets whose recorded duration is implausibly short for their text are automatically treated as pending, so interrupted or older projects repair only defective entries instead of regenerating the full library.
