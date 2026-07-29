# SyncVoice

SyncVoice turns large dialogue sources into Gemini native-audio voice releases with synchronized transcripts. Its primary workflow is designed for games and other projects containing hundreds or thousands of independently addressable lines.

## Project workflow

1. Create a durable project.
2. Import CSV, TSV, JSON, SyncVoice JSON, or plain text.
3. Assign one Gemini voice and optional performance direction per character.
4. Generate pending or selected dialogue through a resumable queue.
5. Review individual entries and regenerate only changed lines.
6. Build an engine-neutral ZIP release containing WAV, WebVTT, SRT, word timing, a CSV index, and `project.json`.

The Quick Studio remains available at `/quick` for one-off voice clips.

## Import fields

CSV/TSV and JSON imports recognize common aliases for these fields:

| Canonical field | Common aliases | Required |
| --- | --- | --- |
| `text` | `dialogue`, `line`, `content`, `subtitle` | Yes |
| `external_id` | `id`, `key`, `line_id`, `string_id` | No |
| `speaker` | `character`, `actor`, `name` | No |
| `scene` | `chapter`, `quest`, `group` | No |
| `locale` | `language`, `lang` | No |
| `direction` | `emotion`, `notes` | No |
| `voice` | — | No |

Stable external IDs are essential: reimporting the same ID updates that entry, while unchanged dialogue keeps its existing generated audio.

## Release layout

```text
project.json
dialogue.csv
audio/<locale>/<dialogue-id>.wav
captions/<locale>/<dialogue-id>.vtt
captions/<locale>/<dialogue-id>.srt
README.txt
```

`project.json` is the canonical engine-neutral manifest and includes character, text, duration, transcript, file paths, and word-level millisecond timing. The same structure can be adapted for Unity, Unreal Engine, Godot, custom engines, and modding tools.

## Architecture

- Gemini `gemini-2.5-flash-native-audio-preview-12-2025` Live API for audio and output transcription
- Short-lived browser session tokens provisioned with four server-side rotating API keys
- Cloudflare D1 for projects, membership, character casting, entries, queue state, revisions, and transcript timing
- Cloudflare R2 for generated WAV assets
- Stable dialogue IDs and revision-based invalidation
- Device-local settings only for non-authoritative UI preferences
- Portable `.syncvoice.json` project handoffs

## Development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm run lint
npx tsc --noEmit
npm test
```

Generate a new migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

Gemini keys are loaded from ignored environment files as `GEMINI_API_KEY1` through `GEMINI_API_KEY4` and are never included in client bundles.
