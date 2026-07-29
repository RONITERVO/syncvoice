import type { EntryStatus, TimedWord } from "@/lib/project-types";
import { canWrite, getAudioBucket, getDatabase, getProjectRole, getRequestUser, hashText, jsonError } from "@/lib/server/project-store";

type Context = { params: Promise<{ projectId: string; entryId: string }> };
const STATUSES: EntryStatus[] = ["pending", "queued", "generating", "ready", "review", "error"];
const VOICES = new Set(["Kore", "Aoede", "Charon", "Fenrir", "Puck", "Leda", "Orus", "Zephyr"]);

export async function PATCH(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to update dialogue.", 401);
  const { projectId, entryId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const current = await database.prepare("SELECT * FROM entries WHERE id = ?1 AND project_id = ?2 LIMIT 1")
    .bind(entryId, projectId).first<Record<string, string | number | null>>();
  if (!current) return jsonError("Dialogue entry not found.", 404);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid request body.", 400);

  const externalId = typeof body.externalId === "string" && body.externalId.trim() ? body.externalId.trim().slice(0, 180) : String(current.external_id);
  const scene = typeof body.scene === "string" ? body.scene.trim().slice(0, 180) : String(current.scene);
  const speaker = typeof body.speaker === "string" && body.speaker.trim() ? body.speaker.trim().slice(0, 120) : String(current.speaker);
  const dialogue = typeof body.text === "string" && body.text.trim() ? body.text.trim().slice(0, 8_000) : String(current.text);
  const locale = typeof body.locale === "string" && body.locale.trim() ? body.locale.trim().slice(0, 20) : String(current.locale);
  const voice = typeof body.voice === "string" && VOICES.has(body.voice) ? body.voice : String(current.voice);
  const direction = typeof body.direction === "string" ? body.direction.trim().slice(0, 500) : String(current.direction);
  const requestedStatus = typeof body.status === "string" && STATUSES.includes(body.status as EntryStatus) ? body.status as EntryStatus : current.status as EntryStatus;
  const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, 12_000) : String(current.transcript);
  const cues = Array.isArray(body.cues) ? body.cues.filter((cue): cue is TimedWord => {
    if (!cue || typeof cue !== "object") return false;
    const item = cue as Partial<TimedWord>;
    return typeof item.word === "string" && typeof item.startMs === "number" && typeof item.endMs === "number";
  }).slice(0, 20_000) : JSON.parse(String(current.cues_json || "[]")) as TimedWord[];
  const durationMs = typeof body.durationMs === "number" && Number.isFinite(body.durationMs) ? Math.max(0, Math.round(body.durationMs)) : current.duration_ms;
  const error = body.error === null ? null : typeof body.error === "string" ? body.error.slice(0, 1_000) : current.error;
  const textHash = hashText(`${dialogue}\n${direction}`);
  const audioAffectingChange = textHash !== current.text_hash || voice !== current.voice || locale !== current.locale;
  const status = audioAffectingChange ? "pending" : requestedStatus;
  const now = Date.now();

  try {
    await database.batch([
      database.prepare(`
        UPDATE entries SET external_id = ?1, scene = ?2, speaker = ?3, text = ?4, locale = ?5, voice = ?6,
          direction = ?7, status = ?8, transcript = ?9, cues_json = ?10,
          audio_key = ?11, duration_ms = ?12, text_hash = ?13, revision = ?14, error = ?15, updated_at = ?16
        WHERE id = ?17 AND project_id = ?18
      `).bind(
        externalId, scene, speaker, dialogue, locale, voice, direction, status,
        audioAffectingChange ? "" : transcript, audioAffectingChange ? "[]" : JSON.stringify(cues),
        audioAffectingChange ? null : current.audio_key, audioAffectingChange ? null : durationMs,
        textHash, Number(current.revision) + (audioAffectingChange ? 1 : 0), error, now, entryId, projectId,
      ),
      database.prepare(`
        INSERT INTO characters (id, project_id, name, voice, direction, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, '', ?5, ?5)
        ON CONFLICT(project_id, name) DO NOTHING
      `).bind(crypto.randomUUID(), projectId, speaker, voice, now),
      database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(now, projectId),
    ]);
  } catch (caught) {
    if (/unique/i.test(caught instanceof Error ? caught.message : "")) return jsonError("That dialogue ID is already used in this project.", 409);
    throw caught;
  }
  return Response.json({ ok: true, status, resetAudio: audioAffectingChange });
}

export async function DELETE(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to delete dialogue.", 401);
  const { projectId, entryId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const row = await database.prepare("SELECT audio_key FROM entries WHERE id = ?1 AND project_id = ?2")
    .bind(entryId, projectId).first<{ audio_key: string | null }>();
  if (!row) return jsonError("Dialogue entry not found.", 404);
  if (row.audio_key) await getAudioBucket().delete(row.audio_key);
  await database.batch([
    database.prepare("DELETE FROM entries WHERE id = ?1 AND project_id = ?2").bind(entryId, projectId),
    database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(Date.now(), projectId),
  ]);
  return Response.json({ ok: true });
}
