export type EntryStatus = "pending" | "queued" | "generating" | "ready" | "review" | "error";

export type TimedWord = { word: string; startMs: number; endMs: number };

export type ProjectEntry = {
  id: string;
  projectId: string;
  externalId: string;
  scene: string;
  speaker: string;
  text: string;
  locale: string;
  voice: string;
  direction: string;
  status: EntryStatus;
  transcript: string;
  cues: TimedWord[];
  hasAudio: boolean;
  durationMs: number | null;
  revision: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProjectCharacter = {
  id: string;
  name: string;
  voice: string;
  direction: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  sourceLocale: string;
  targetEngine: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  readyCount: number;
  errorCount: number;
  queuedCount: number;
};

export type ProjectDetail = ProjectSummary & {
  characters: ProjectCharacter[];
  entries: ProjectEntry[];
};

export type ImportedEntry = {
  externalId: string;
  scene: string;
  speaker: string;
  text: string;
  locale: string;
  voice?: string;
  direction?: string;
};
