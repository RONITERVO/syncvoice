import type { EntryStatus, ImportedEntry } from "@/lib/project-types";
import { canWrite, getDatabase, getProjectRole, getRequestUser, hashText, jsonError } from "@/lib/server/project-store";

type Context = { params: Promise<{ projectId: string }> };
const VOICES = new Set(["Kore", "Aoede", "Charon", "Fenrir", "Puck", "Leda", "Orus", "Zephyr"]);

function cleanEntry(value: ImportedEntry, index: number, localeFallback: string) {
  const text = typeof value.text === "string" ? value.text.trim().slice(0, 8_000) : "";
  if (!text) return null;
  const externalId = typeof value.externalId === "string" && value.externalId.trim()
    ? value.externalId.trim().slice(0, 180)
    : `line_${String(index + 1).padStart(5, "0")}`;
  const speaker = typeof value.speaker === "string" && value.speaker.trim() ? value.speaker.trim().slice(0, 120) : "Narrator";
  return {
    externalId,
    scene: typeof value.scene === "string" ? value.scene.trim().slice(0, 180) : "",
    speaker,
    text,
    locale: typeof value.locale === "string" && value.locale.trim() ? value.locale.trim().slice(0, 20) : localeFallback,
    voice: typeof value.voice === "string" && VOICES.has(value.voice) ? value.voice : "Kore",
    direction: typeof value.direction === "string" ? value.direction.trim().slice(0, 500) : "",
  };
}

export async function POST(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to import dialogue.", 401);
  const { projectId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const project = await database.prepare("SELECT source_locale FROM projects WHERE id = ?1").bind(projectId).first<{ source_locale: string }>();
  if (!project) return jsonError("Project not found.", 404);
  const body = await request.json().catch(() => null) as { entries?: ImportedEntry[] } | null;
  if (!Array.isArray(body?.entries) || !body.entries.length) return jsonError("No dialogue entries were provided.", 400);
  if (body.entries.length > 250) return jsonError("Import entries in batches of 250 or fewer.", 413);
  const cleaned = body.entries.map((entry, index) => cleanEntry(entry, index, project.source_locale)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (!cleaned.length) return jsonError("No entries contained readable dialogue text.", 400);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const speakers = new Map<string, string>();
  for (const entry of cleaned) if (!speakers.has(entry.speaker)) speakers.set(entry.speaker, entry.voice);
  for (const [speaker, voice] of speakers) {
    statements.push(database.prepare(`
      INSERT INTO characters (id, project_id, name, voice, direction, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, '', ?5, ?5)
      ON CONFLICT(project_id, name) DO NOTHING
    `).bind(crypto.randomUUID(), projectId, speaker, voice, now));
  }
  for (const entry of cleaned) {
    const textHash = hashText(`${entry.text}\n${entry.direction}`);
    statements.push(database.prepare(`
      INSERT INTO entries (
        id, project_id, external_id, scene, speaker, text, locale, voice, direction, status,
        transcript, cues_json, text_hash, revision, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', '', '[]', ?10, 1, ?11, ?11)
      ON CONFLICT(project_id, external_id) DO UPDATE SET
        scene = excluded.scene,
        speaker = excluded.speaker,
        text = excluded.text,
        locale = excluded.locale,
        direction = excluded.direction,
        voice = CASE WHEN entries.speaker = excluded.speaker THEN entries.voice ELSE excluded.voice END,
        status = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.status ELSE 'pending' END,
        transcript = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.transcript ELSE '' END,
        cues_json = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.cues_json ELSE '[]' END,
        audio_key = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.audio_key ELSE NULL END,
        duration_ms = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.duration_ms ELSE NULL END,
        text_hash = excluded.text_hash,
        revision = CASE WHEN entries.text_hash = excluded.text_hash AND entries.speaker = excluded.speaker THEN entries.revision ELSE entries.revision + 1 END,
        error = NULL,
        updated_at = excluded.updated_at
    `).bind(crypto.randomUUID(), projectId, entry.externalId, entry.scene, entry.speaker, entry.text, entry.locale, entry.voice, entry.direction, textHash, now));
  }
  statements.push(database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(now, projectId));
  await database.batch(statements);
  return Response.json({ imported: cleaned.length, characters: speakers.size });
}

export async function PATCH(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to update the queue.", 401);
  const { projectId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const body = await request.json().catch(() => null) as { ids?: unknown; status?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 500) : [];
  const status = typeof body?.status === "string" ? body.status as EntryStatus : "pending";
  if (!ids.length || !["pending", "queued"].includes(status)) return jsonError("A valid entry selection and queue status are required.", 400);
  const now = Date.now();
  await database.batch(ids.map((id) => database.prepare("UPDATE entries SET status = ?1, error = NULL, updated_at = ?2 WHERE id = ?3 AND project_id = ?4")
    .bind(status, now, id, projectId)));
  await database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(now, projectId).run();
  return Response.json({ updated: ids.length });
}
