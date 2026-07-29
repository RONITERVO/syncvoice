import type { ProjectEntry, TimedWord } from "@/lib/project-types";
import { canWrite, getAudioBucket, getDatabase, getProjectRole, getRequestUser, jsonError, safeJson } from "@/lib/server/project-store";

type Context = { params: Promise<{ projectId: string }> };
type EntryRow = {
  id: string; project_id: string; external_id: string; scene: string; speaker: string; text: string; locale: string;
  voice: string; direction: string; status: ProjectEntry["status"]; transcript: string; cues_json: string; audio_key: string | null;
  duration_ms: number | null; revision: number; error: string | null; created_at: number; updated_at: number;
};

function serializeEntry(row: EntryRow): ProjectEntry {
  return {
    id: row.id, projectId: row.project_id, externalId: row.external_id, scene: row.scene, speaker: row.speaker,
    text: row.text, locale: row.locale, voice: row.voice, direction: row.direction, status: row.status,
    transcript: row.transcript, cues: safeJson<TimedWord[]>(row.cues_json, []), hasAudio: Boolean(row.audio_key),
    durationMs: row.duration_ms, revision: row.revision, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function GET(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to access projects.", 401);
  const { projectId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!role) return jsonError("Project not found.", 404);

  const [project, entryResult, characterResult] = await Promise.all([
    database.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id) AS entry_count,
        (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.status = 'ready') AS ready_count,
        (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.status = 'error') AS error_count,
        (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.status IN ('queued', 'generating')) AS queued_count
      FROM projects p WHERE p.id = ?1 LIMIT 1
    `).bind(projectId).first<Record<string, string | number>>(),
    database.prepare("SELECT * FROM entries WHERE project_id = ?1 ORDER BY scene COLLATE NOCASE, external_id COLLATE NOCASE LIMIT 20000")
      .bind(projectId).all<EntryRow>(),
    database.prepare("SELECT id, name, voice, direction FROM characters WHERE project_id = ?1 ORDER BY name COLLATE NOCASE")
      .bind(projectId).all<{ id: string; name: string; voice: string; direction: string }>(),
  ]);
  if (!project) return jsonError("Project not found.", 404);
  return Response.json({
    project: {
      id: project.id, name: project.name, description: project.description, sourceLocale: project.source_locale,
      targetEngine: project.target_engine, createdAt: project.created_at, updatedAt: project.updated_at,
      entryCount: Number(project.entry_count), readyCount: Number(project.ready_count), errorCount: Number(project.error_count),
      queuedCount: Number(project.queued_count), characters: characterResult.results, entries: entryResult.results.map(serializeEntry), role,
    },
  });
}

export async function PATCH(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to update projects.", 401);
  const { projectId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid request body.", 400);
  const current = await database.prepare("SELECT name, description, source_locale, target_engine FROM projects WHERE id = ?1")
    .bind(projectId).first<{ name: string; description: string; source_locale: string; target_engine: string }>();
  if (!current) return jsonError("Project not found.", 404);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : current.name;
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : current.description;
  const sourceLocale = typeof body.sourceLocale === "string" ? body.sourceLocale.trim().slice(0, 20) : current.source_locale;
  const targetEngine = typeof body.targetEngine === "string" ? body.targetEngine.trim().slice(0, 30) : current.target_engine;
  if (!name) return jsonError("Project name is required.", 400);
  await database.prepare("UPDATE projects SET name = ?1, description = ?2, source_locale = ?3, target_engine = ?4, updated_at = ?5 WHERE id = ?6")
    .bind(name, description, sourceLocale, targetEngine, Date.now(), projectId).run();
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to delete projects.", 401);
  const { projectId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (role !== "owner") return jsonError("Only the project owner can delete this project.", role ? 403 : 404);
  const bucket = getAudioBucket();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `projects/${projectId}/`, cursor });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await database.prepare("DELETE FROM projects WHERE id = ?1").bind(projectId).run();
  return Response.json({ ok: true });
}
