import { canWrite, getDatabase, getProjectRole, getRequestUser, jsonError } from "@/lib/server/project-store";

type Context = { params: Promise<{ projectId: string; characterId: string }> };
const VOICES = new Set(["Kore", "Aoede", "Charon", "Fenrir", "Puck", "Leda", "Orus", "Zephyr"]);

export async function PATCH(request: Request, context: Context) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to update character casting.", 401);
  const { projectId, characterId } = await context.params;
  const database = getDatabase();
  const role = await getProjectRole(database, projectId, email);
  if (!canWrite(role)) return jsonError("You do not have permission to edit this project.", role ? 403 : 404);
  const current = await database.prepare("SELECT name, voice, direction FROM characters WHERE id = ?1 AND project_id = ?2")
    .bind(characterId, projectId).first<{ name: string; voice: string; direction: string }>();
  if (!current) return jsonError("Character not found.", 404);
  const body = await request.json().catch(() => null) as { voice?: unknown; direction?: unknown; applyToEntries?: unknown } | null;
  const voice = typeof body?.voice === "string" && VOICES.has(body.voice) ? body.voice : current.voice;
  const direction = typeof body?.direction === "string" ? body.direction.trim().slice(0, 500) : current.direction;
  const applyToEntries = body?.applyToEntries !== false;
  const now = Date.now();
  const statements = [
    database.prepare("UPDATE characters SET voice = ?1, direction = ?2, updated_at = ?3 WHERE id = ?4 AND project_id = ?5")
      .bind(voice, direction, now, characterId, projectId),
    database.prepare("UPDATE projects SET updated_at = ?1 WHERE id = ?2").bind(now, projectId),
  ];
  if (applyToEntries) {
    statements.push(database.prepare(`
      UPDATE entries SET voice = ?1, direction = CASE WHEN direction = '' THEN ?2 ELSE direction END,
        status = CASE WHEN voice = ?1 THEN status ELSE 'pending' END,
        transcript = CASE WHEN voice = ?1 THEN transcript ELSE '' END,
        cues_json = CASE WHEN voice = ?1 THEN cues_json ELSE '[]' END,
        audio_key = CASE WHEN voice = ?1 THEN audio_key ELSE NULL END,
        duration_ms = CASE WHEN voice = ?1 THEN duration_ms ELSE NULL END,
        revision = CASE WHEN voice = ?1 THEN revision ELSE revision + 1 END,
        error = NULL, updated_at = ?3
      WHERE project_id = ?4 AND speaker = ?5
    `).bind(voice, direction, now, projectId, current.name));
  }
  await database.batch(statements);
  return Response.json({ ok: true });
}
