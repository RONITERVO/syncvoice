import { env } from "cloudflare:workers";

export type ProjectRole = "owner" | "editor" | "viewer";

export function getDatabase() {
  if (!env.DB) throw new Error("Project database is unavailable.");
  return env.DB as D1Database;
}

export function getAudioBucket() {
  if (!env.AUDIO) throw new Error("Audio storage is unavailable.");
  return env.AUDIO as R2Bucket;
}

export function getRequestUser(request: Request) {
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email) return email;
  if (process.env.NODE_ENV !== "production") return "local@syncvoice.dev";
  return null;
}

export async function getProjectRole(database: D1Database, projectId: string, email: string): Promise<ProjectRole | null> {
  const row = await database.prepare(
    "SELECT role FROM project_members WHERE project_id = ?1 AND email = ?2 LIMIT 1",
  ).bind(projectId, email).first<{ role: ProjectRole }>();
  return row?.role ?? null;
}

export function canWrite(role: ProjectRole | null) {
  return role === "owner" || role === "editor";
}

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
