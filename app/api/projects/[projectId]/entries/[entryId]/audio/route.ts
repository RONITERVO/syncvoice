import { canWrite, getAudioBucket, getDatabase, getProjectRole, getRequestUser, jsonError } from "@/lib/server/project-store";

type Context = { params: Promise<{ projectId: string; entryId: string }> };

export async function GET(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to play project audio.", 401);
  const { projectId, entryId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!role) return jsonError("Project not found.", 404);
  const row = await database.prepare("SELECT audio_key FROM entries WHERE id = ?1 AND project_id = ?2")
    .bind(entryId, projectId).first<{ audio_key: string | null }>();
  if (!row?.audio_key) return jsonError("Audio has not been generated for this entry.", 404);
  const object = await getAudioBucket().get(row.audio_key);
  if (!object) return jsonError("Stored audio could not be found.", 404);
  const responseHeaders = new Headers();
  object.writeHttpMetadata(responseHeaders);
  responseHeaders.set("etag", object.httpEtag);
  responseHeaders.set("content-length", String(object.size));
  responseHeaders.set("cache-control", "private, max-age=3600");
  responseHeaders.set("content-disposition", `inline; filename="${entryId}.wav"`);
  return new Response(object.body, { headers: responseHeaders });
}

export async function POST(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to store project audio.", 401);
  const { projectId, entryId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const row = await database.prepare("SELECT external_id, revision FROM entries WHERE id = ?1 AND project_id = ?2")
    .bind(entryId, projectId).first<{ external_id: string; revision: number }>();
  if (!row) return jsonError("Dialogue entry not found.", 404);
  if (!request.body) return jsonError("A WAV audio body is required.", 400);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 50 * 1024 * 1024) return jsonError("Individual audio files are limited to 50 MB.", 413);
  const durationMs = Math.max(0, Number(request.headers.get("x-syncvoice-duration-ms") ?? 0));
  const key = `projects/${projectId}/audio/${entryId}.wav`;
  await getAudioBucket().put(key, request.body, {
    httpMetadata: { contentType: "audio/wav", cacheControl: "private, max-age=3600" },
    customMetadata: { projectId, entryId, externalId: row.external_id, revision: String(row.revision) },
  });
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE entries SET audio_key = ?1, duration_ms = ?2, status = 'ready', error = NULL, updated_at = ?3 WHERE id = ?4 AND project_id = ?5")
      .bind(key, Math.round(durationMs), now, entryId, projectId),
    database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(now, projectId),
  ]);
  return Response.json({ ok: true, key });
}
