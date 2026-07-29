import { getDatabase, getRequestUser, jsonError } from "@/lib/server/project-store";

type ProjectRow = {
  id: string; name: string; description: string; source_locale: string; target_engine: string;
  created_at: number; updated_at: number; entry_count: number; ready_count: number; error_count: number; queued_count: number;
};

function serialize(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceLocale: row.source_locale,
    targetEngine: row.target_engine,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryCount: Number(row.entry_count),
    readyCount: Number(row.ready_count),
    errorCount: Number(row.error_count),
    queuedCount: Number(row.queued_count),
  };
}

export async function GET(request: Request) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to access projects.", 401);
  const database = getDatabase();
  const result = await database.prepare(`
    SELECT p.id, p.name, p.description, p.source_locale, p.target_engine, p.created_at, p.updated_at,
      COUNT(e.id) AS entry_count,
      SUM(CASE WHEN e.status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN e.status IN ('queued', 'generating') THEN 1 ELSE 0 END) AS queued_count
    FROM projects p
    JOIN project_members m ON m.project_id = p.id AND m.email = ?1
    LEFT JOIN entries e ON e.project_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).bind(email).all<ProjectRow>();
  return Response.json({ projects: result.results.map(serialize) });
}

export async function POST(request: Request) {
  const email = getRequestUser(request);
  if (!email) return jsonError("Sign in to create a project.", 401);
  const body = await request.json().catch(() => null) as { name?: unknown; description?: unknown; sourceLocale?: unknown; targetEngine?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return jsonError("Project name is required.", 400);
  const now = Date.now();
  const id = crypto.randomUUID();
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 500) : "";
  const sourceLocale = typeof body?.sourceLocale === "string" ? body.sourceLocale.trim().slice(0, 20) : "en-US";
  const targetEngine = typeof body?.targetEngine === "string" ? body.targetEngine.trim().slice(0, 30) : "universal";
  const database = getDatabase();
  await database.batch([
    database.prepare("INSERT INTO projects (id, owner_email, name, description, source_locale, target_engine, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)")
      .bind(id, email, name, description, sourceLocale, targetEngine, now),
    database.prepare("INSERT INTO project_members (project_id, email, role, created_at) VALUES (?1, ?2, 'owner', ?3)")
      .bind(id, email, now),
  ]);
  return Response.json({ project: serialize({ id, name, description, source_locale: sourceLocale, target_engine: targetEngine, created_at: now, updated_at: now, entry_count: 0, ready_count: 0, error_count: 0, queued_count: 0 }) }, { status: 201 });
}
