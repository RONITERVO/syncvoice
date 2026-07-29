import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sourceLocale: text("source_locale").notNull().default("en-US"),
  targetEngine: text("target_engine").notNull().default("universal"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("projects_owner_updated_idx").on(table.ownerEmail, table.updatedAt)]);

export const projectMembers = sqliteTable("project_members", {
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("viewer"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.email] }),
  index("project_members_email_idx").on(table.email),
]);

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  voice: text("voice").notNull().default("Kore"),
  direction: text("direction").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("characters_project_name_idx").on(table.projectId, table.name),
  index("characters_project_idx").on(table.projectId),
]);

export const entries = sqliteTable("entries", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  scene: text("scene").notNull().default(""),
  speaker: text("speaker").notNull().default("Narrator"),
  text: text("text").notNull(),
  locale: text("locale").notNull().default("en-US"),
  voice: text("voice").notNull().default("Kore"),
  direction: text("direction").notNull().default(""),
  status: text("status").notNull().default("pending"),
  transcript: text("transcript").notNull().default(""),
  cuesJson: text("cues_json").notNull().default("[]"),
  audioKey: text("audio_key"),
  durationMs: integer("duration_ms"),
  textHash: text("text_hash").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("entries_project_external_idx").on(table.projectId, table.externalId),
  index("entries_project_status_idx").on(table.projectId, table.status),
  index("entries_project_scene_idx").on(table.projectId, table.scene),
  index("entries_project_speaker_idx").on(table.projectId, table.speaker),
]);
