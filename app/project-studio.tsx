"use client";

import {
  Archive,
  AudioLines,
  Check,
  ChevronRight,
  CirclePause,
  Cloud,
  Download,
  FileUp,
  FolderKanban,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AgentPanel } from "@/app/agent-panel";
import { generateDialogueAudio } from "@/lib/client/gemini-tts";
import type { ImportedEntry, ProjectCharacter, ProjectDetail, ProjectEntry, ProjectSummary, TimedWord } from "@/lib/project-types";

const VOICES = ["Kore", "Aoede", "Charon", "Fenrir", "Puck", "Leda", "Orus", "Zephyr"];
const PAGE_SIZE = 100;

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeRecord(record: Record<string, unknown>, index: number, fallbackLocale: string): ImportedEntry | null {
  const lower = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.trim().toLowerCase().replace(/[\s-]+/g, "_"), value]));
  const text = lower.text ?? lower.dialogue ?? lower.line ?? lower.content ?? lower.subtitle;
  if (typeof text !== "string" || !text.trim()) return null;
  const externalId = lower.external_id ?? lower.id ?? lower.key ?? lower.line_id ?? lower.string_id;
  return {
    externalId: typeof externalId === "string" || typeof externalId === "number" ? String(externalId) : `line_${String(index + 1).padStart(5, "0")}`,
    scene: String(lower.scene ?? lower.chapter ?? lower.quest ?? lower.group ?? ""),
    speaker: String(lower.speaker ?? lower.character ?? lower.actor ?? lower.name ?? "Narrator"),
    text: text.trim(),
    locale: String(lower.locale ?? lower.language ?? lower.lang ?? fallbackLocale),
    voice: typeof lower.voice === "string" ? lower.voice : undefined,
    direction: String(lower.direction ?? lower.emotion ?? lower.notes ?? ""),
  };
}

async function parseImportFile(file: File, fallbackLocale: string): Promise<ImportedEntry[]> {
  const text = await file.text();
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "json" || extension === "syncvoice") {
    const parsed = JSON.parse(text) as unknown;
    const source = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    return source.map((item, index) => item && typeof item === "object" ? normalizeRecord(item as Record<string, unknown>, index, fallbackLocale) : null)
      .filter((entry): entry is ImportedEntry => Boolean(entry));
  }
  if (extension === "csv" || extension === "tsv") {
    const delimiter = extension === "tsv" ? "\t" : ",";
    const rows = parseDelimited(text, delimiter);
    if (rows.length < 2) return [];
    const headers = rows[0];
    return rows.slice(1).map((row, index) => normalizeRecord(Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""])), index, fallbackLocale))
      .filter((entry): entry is ImportedEntry => Boolean(entry));
  }
  return text.split(/\r?\n/).map((line, index) => line.trim() ? ({
    externalId: `line_${String(index + 1).padStart(5, "0")}`,
    scene: "", speaker: "Narrator", text: line.trim(), locale: fallbackLocale,
  }) : null).filter((entry): entry is ImportedEntry => Boolean(entry));
}

function safeFilename(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "dialogue";
}

function captionTime(milliseconds: number, separator: "." | ",") {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function groupCues(cues: TimedWord[], size = 7) {
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const cue of cues) {
    current.push(cue);
    if (current.length >= size || /[.!?][\]"')]*$/.test(cue.word)) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

function createVtt(cues: TimedWord[]) {
  return `WEBVTT\n\n${groupCues(cues).map((group, index) => `${index + 1}\n${captionTime(group[0].startMs, ".")} --> ${captionTime(group.at(-1)!.endMs, ".")}\n${group.map((cue) => cue.word).join(" ")}`).join("\n\n")}\n`;
}

function createSrt(cues: TimedWord[]) {
  return `${groupCues(cues).map((group, index) => `${index + 1}\n${captionTime(group[0].startMs, ",")} --> ${captionTime(group.at(-1)!.endMs, ",")}\n${group.map((cue) => cue.word).join(" ")}`).join("\n\n")}\n`;
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function ProjectStudio() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectEngine, setNewProjectEngine] = useState("universal");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [editingEntry, setEditingEntry] = useState<ProjectEntry | null>(null);
  const [showCasting, setShowCasting] = useState(false);
  const [castChanges, setCastChanges] = useState<Record<string, { voice: string; direction: string }>>({});
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueProgress, setQueueProgress] = useState({ current: 0, total: 0, label: "" });
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [releaseProgress, setReleaseProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const projectImportRef = useRef<HTMLInputElement | null>(null);
  const queueAbortRef = useRef<AbortController | null>(null);

  const loadProject = useCallback(async (projectId: string) => {
    setLoading(true);
    try {
      const result = await api<{ project: ProjectDetail }>(`/api/projects/${projectId}`);
      setActiveProject(result.project);
      setSelected(new Set());
      setPage(1);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the project.");
    } finally { setLoading(false); }
  }, []);

  const loadProjects = useCallback(async (preferredId?: string) => {
    try {
      const result = await api<{ projects: ProjectSummary[] }>("/api/projects");
      setProjects(result.projects);
      const nextId = preferredId ?? activeProject?.id ?? result.projects[0]?.id;
      if (nextId) await loadProject(nextId);
      else { setActiveProject(null); setLoading(false); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load projects.");
      setLoading(false);
    }
  }, [activeProject, loadProject]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const result = await api<{ projects: ProjectSummary[] }>("/api/projects");
        const first = result.projects[0];
        const detail = first ? await api<{ project: ProjectDetail }>(`/api/projects/${first.id}`) : null;
        if (cancelled) return;
        setProjects(result.projects);
        setActiveProject(detail?.project ?? null);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load projects.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  const refreshActive = useCallback(async () => {
    if (!activeProject) return;
    const result = await api<{ project: ProjectDetail }>(`/api/projects/${activeProject.id}`);
    setActiveProject(result.project);
    const summaries = await api<{ projects: ProjectSummary[] }>("/api/projects");
    setProjects(summaries.projects);
  }, [activeProject]);

  const createProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const result = await api<{ project: ProjectSummary }>("/api/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, targetEngine: newProjectEngine, sourceLocale: "en-US" }),
      });
      setShowNewProject(false); setNewProjectName("");
      await loadProjects(result.project.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the project."); }
  }, [loadProjects, newProjectEngine, newProjectName]);

  const importEntries = useCallback(async (file: File) => {
    if (!activeProject) return;
    setImportProgress("Reading source file…"); setError(null);
    try {
      const imported = await parseImportFile(file, activeProject.sourceLocale);
      if (!imported.length) throw new Error("No dialogue rows were found. Include a text or dialogue column.");
      const characterVoices = new Map(activeProject.characters.map((character) => [character.name.toLowerCase(), character.voice]));
      const newSpeakers = [...new Set(imported.map((entry) => entry.speaker.toLowerCase()).filter((speaker) => !characterVoices.has(speaker)))];
      newSpeakers.forEach((speaker, index) => characterVoices.set(speaker, VOICES[index % VOICES.length]));
      const prepared = imported.map((entry) => ({ ...entry, voice: entry.voice && VOICES.includes(entry.voice) ? entry.voice : characterVoices.get(entry.speaker.toLowerCase()) ?? "Kore" }));
      for (let offset = 0; offset < prepared.length; offset += 200) {
        setImportProgress(`Importing ${Math.min(offset + 200, prepared.length).toLocaleString()} of ${prepared.length.toLocaleString()} lines…`);
        await api(`/api/projects/${activeProject.id}/entries`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: prepared.slice(offset, offset + 200) }),
        });
      }
      setNotice(`${prepared.length.toLocaleString()} dialogue lines imported.`);
      await refreshActive();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Import failed."); }
    finally { setImportProgress(null); if (importInputRef.current) importInputRef.current.value = ""; if (projectImportRef.current) projectImportRef.current.value = ""; }
  }, [activeProject, refreshActive]);

  const updateLocalEntry = useCallback((entryId: string, patch: Partial<ProjectEntry>) => {
    setActiveProject((project) => project ? { ...project, entries: project.entries.map((entry) => entry.id === entryId ? { ...entry, ...patch } : entry) } : project);
  }, []);

  const runQueue = useCallback(async (entryIds: string[]) => {
    if (!activeProject || queueRunning || !entryIds.length) return;
    const controller = new AbortController();
    queueAbortRef.current = controller;
    setQueueRunning(true); setError(null);
    try {
      await api(`/api/projects/${activeProject.id}/entries`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: entryIds, status: "queued" }),
      });
      entryIds.forEach((id) => updateLocalEntry(id, { status: "queued", error: null }));
      for (let index = 0; index < entryIds.length; index += 1) {
        if (controller.signal.aborted) break;
        const entryId = entryIds[index];
        const entry = activeProject.entries.find((item) => item.id === entryId);
        if (!entry) continue;
        setQueueProgress({ current: index + 1, total: entryIds.length, label: `${entry.speaker} · ${entry.externalId}` });
        updateLocalEntry(entryId, { status: "generating", error: null });
        await api(`/api/projects/${activeProject.id}/entries/${entryId}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "generating", error: null }),
        });
        try {
          const generated = await generateDialogueAudio({ ...entry, signal: controller.signal });
          await api(`/api/projects/${activeProject.id}/entries/${entryId}`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "generating", transcript: generated.transcript, cues: generated.cues, durationMs: generated.durationMs, error: null }),
          });
          const audioResponse = await fetch(`/api/projects/${activeProject.id}/entries/${entryId}/audio`, {
            method: "POST", headers: { "content-type": "audio/wav", "x-syncvoice-duration-ms": String(generated.durationMs) },
            body: generated.wav, signal: controller.signal,
          });
          if (!audioResponse.ok) {
            const audioError = await audioResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(audioError?.error || "Audio upload failed.");
          }
          updateLocalEntry(entryId, { status: "ready", transcript: generated.transcript, cues: generated.cues, durationMs: generated.durationMs, hasAudio: true });
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") {
            await api(`/api/projects/${activeProject.id}/entries/${entryId}`, {
              method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "queued", error: null }),
            }).catch(() => undefined);
            updateLocalEntry(entryId, { status: "queued" });
            break;
          }
          const message = caught instanceof Error ? caught.message : "Generation failed.";
          await api(`/api/projects/${activeProject.id}/entries/${entryId}`, {
            method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "error", error: message }),
          }).catch(() => undefined);
          updateLocalEntry(entryId, { status: "error", error: message });
        }
      }
      setNotice(controller.signal.aborted ? "Queue paused. Resume whenever you are ready." : "Generation queue complete.");
      await refreshActive();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The generation queue stopped."); }
    finally { setQueueRunning(false); setQueueProgress({ current: 0, total: 0, label: "" }); queueAbortRef.current = null; }
  }, [activeProject, queueRunning, refreshActive, updateLocalEntry]);

  const saveEntry = useCallback(async () => {
    if (!activeProject || !editingEntry) return;
    try {
      await api(`/api/projects/${activeProject.id}/entries/${editingEntry.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(editingEntry),
      });
      setEditingEntry(null); setNotice("Dialogue entry saved."); await refreshActive();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the entry."); }
  }, [activeProject, editingEntry, refreshActive]);

  const applyCasting = useCallback(async (character: ProjectCharacter) => {
    if (!activeProject) return;
    const change = castChanges[character.id] ?? { voice: character.voice, direction: character.direction };
    try {
      await api(`/api/projects/${activeProject.id}/characters/${character.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...change, applyToEntries: true }),
      });
      setNotice(`${character.name} is now cast as ${change.voice}.`); await refreshActive();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update casting."); }
  }, [activeProject, castChanges, refreshActive]);

  const exportProjectSource = useCallback(() => {
    if (!activeProject) return;
    const payload = {
      format: "syncvoice-project", version: 1,
      project: { name: activeProject.name, description: activeProject.description, sourceLocale: activeProject.sourceLocale, targetEngine: activeProject.targetEngine },
      characters: activeProject.characters,
      entries: activeProject.entries.map(({ externalId, scene, speaker, text, locale, voice, direction }) => ({ externalId, scene, speaker, text, locale, voice, direction })),
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${safeFilename(activeProject.name)}.syncvoice.json`);
  }, [activeProject]);

  const exportRelease = useCallback(async () => {
    if (!activeProject || releaseProgress) return;
    const ready = activeProject.entries.filter((entry) => entry.status === "ready" && entry.hasAudio);
    if (!ready.length) return;
    setReleaseProgress("Preparing release…"); setError(null);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const manifestEntries: Record<string, unknown>[] = [];
      for (let index = 0; index < ready.length; index += 1) {
        const entry = ready[index];
        setReleaseProgress(`Collecting ${index + 1} of ${ready.length} audio files…`);
        const base = safeFilename(entry.externalId);
        const locale = safeFilename(entry.locale);
        const audioPath = `audio/${locale}/${base}.wav`;
        const vttPath = `captions/${locale}/${base}.vtt`;
        const srtPath = `captions/${locale}/${base}.srt`;
        const audio = await fetch(`/api/projects/${activeProject.id}/entries/${entry.id}/audio`);
        if (!audio.ok) throw new Error(`Could not retrieve audio for ${entry.externalId}.`);
        zip.file(audioPath, await audio.blob());
        zip.file(vttPath, createVtt(entry.cues));
        zip.file(srtPath, createSrt(entry.cues));
        manifestEntries.push({ id: entry.externalId, scene: entry.scene, speaker: entry.speaker, locale: entry.locale, voice: entry.voice, text: entry.text, transcript: entry.transcript, durationMs: entry.durationMs, audio: audioPath, webvtt: vttPath, srt: srtPath, words: entry.cues });
      }
      const missing = activeProject.entries.filter((entry) => entry.status !== "ready").map((entry) => ({ id: entry.externalId, status: entry.status, error: entry.error }));
      zip.file("project.json", JSON.stringify({ format: "syncvoice-game-audio", version: 1, project: activeProject.name, engine: activeProject.targetEngine, generatedAt: new Date().toISOString(), entries: manifestEntries, missing }, null, 2));
      zip.file("dialogue.csv", ["id,scene,speaker,locale,voice,text,duration_ms,audio,webvtt,srt", ...manifestEntries.map((entry) => [entry.id, entry.scene, entry.speaker, entry.locale, entry.voice, entry.text, entry.durationMs, entry.audio, entry.webvtt, entry.srt].map(csvCell).join(","))].join("\n"));
      zip.file("README.txt", "SyncVoice game-audio release\n\nproject.json is the canonical engine-neutral manifest. dialogue.csv provides a flat index. Audio is stored under audio/<locale>/ and matching WebVTT/SRT tracks under captions/<locale>/. Stable dialogue IDs are preserved across releases.\n");
      setReleaseProgress("Compressing release…");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      downloadBlob(blob, `${safeFilename(activeProject.name)}-release.zip`);
      setNotice(`${ready.length.toLocaleString()} generated lines exported.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Release export failed."); }
    finally { setReleaseProgress(null); }
  }, [activeProject, releaseProgress]);

  const scenes = useMemo(() => activeProject ? [...new Set(activeProject.entries.map((entry) => entry.scene).filter(Boolean))].sort() : [], [activeProject]);
  const filteredEntries = useMemo(() => {
    if (!activeProject) return [];
    const query = search.trim().toLowerCase();
    return activeProject.entries.filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) return false;
      if (sceneFilter !== "all" && entry.scene !== sceneFilter) return false;
      return !query || `${entry.externalId} ${entry.scene} ${entry.speaker} ${entry.text}`.toLowerCase().includes(query);
    });
  }, [activeProject, sceneFilter, search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const visibleEntries = filteredEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selected.has(entry.id));
  const pendingIds = activeProject?.entries.filter((entry) => ["pending", "error", "review"].includes(entry.status)).map((entry) => entry.id) ?? [];
  const resumableIds = activeProject?.entries.filter((entry) => ["queued", "generating"].includes(entry.status)).map((entry) => entry.id) ?? [];

  return (
    <main className="projects-shell">
      <header className="projects-topbar">
        <Link className="brand" href="/"><span className="brand-mark"><AudioLines size={20} /></span><span>SYNCVOICE</span></Link>
        <div className="projects-top-actions">
          <span className="cloud-state"><Cloud size={14} /><i /> Cloud saved</span>
          <AgentPanel />
          <a href="/quick" className="quick-link"><Sparkles size={14} /> Quick studio</a>
        </div>
      </header>

      <div className="projects-layout">
        <aside className="project-sidebar">
          <div className="sidebar-heading"><span>PROJECTS</span><button onClick={() => setShowNewProject(true)} aria-label="New project"><Plus size={16} /></button></div>
          <div className="project-list">
            {projects.map((project) => (
              <button key={project.id} className={activeProject?.id === project.id ? "active" : ""} onClick={() => void loadProject(project.id)}>
                <span className="project-icon"><FolderKanban size={17} /></span>
                <span><strong>{project.name}</strong><small>{project.entryCount.toLocaleString()} lines · {project.readyCount.toLocaleString()} ready</small></span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <button className="new-project-sidebar" onClick={() => setShowNewProject(true)}><Plus size={15} /> New project</button>
          <div className="sidebar-foot"><span>Gemini native audio</span><small>Durable project workspace</small></div>
        </aside>

        <section className="project-main">
          {loading ? (
            <div className="project-empty"><LoaderCircle className="spin" size={28} /><h2>Loading workspace</h2></div>
          ) : !activeProject ? (
            <div className="project-empty onboarding">
              <span className="empty-mark"><FolderKanban size={29} /></span>
              <span className="section-kicker">PROJECT MODE</span>
              <h1>Turn a whole script into<br /><em>production-ready voices.</em></h1>
              <p>Import thousands of dialogue lines, cast characters once, and let a resumable queue build your game-audio release.</p>
              <button className="primary-project-button" onClick={() => setShowNewProject(true)}><Plus size={17} /> Create your first project</button>
            </div>
          ) : (
            <>
              <div className="project-hero-row">
                <div><span className="section-kicker">ACTIVE PROJECT</span><h1>{activeProject.name}</h1><p>{activeProject.description || `${activeProject.targetEngine === "universal" ? "Engine-neutral" : activeProject.targetEngine} dialogue production · ${activeProject.sourceLocale}`}</p></div>
                <div className="project-hero-actions">
                  <input ref={importInputRef} type="file" hidden accept=".csv,.tsv,.json,.txt,.syncvoice" onChange={(event) => event.target.files?.[0] && void importEntries(event.target.files[0])} />
                  <button onClick={() => importInputRef.current?.click()} disabled={Boolean(importProgress)}><FileUp size={16} /> {importProgress ?? "Import dialogue"}</button>
                  <button onClick={() => setShowCasting(true)} disabled={!activeProject.characters.length}><Users size={16} /> Cast voices</button>
                  <button className="release-button" onClick={() => void exportRelease()} disabled={!activeProject.readyCount || Boolean(releaseProgress)}><Archive size={16} /> {releaseProgress ?? "Build release"}</button>
                </div>
              </div>

              <div className="project-stats">
                <div><span>Total lines</span><strong>{activeProject.entryCount.toLocaleString()}</strong><small>Stable dialogue IDs</small></div>
                <div><span>Generated</span><strong>{activeProject.readyCount.toLocaleString()}</strong><small>{activeProject.entryCount ? Math.round((activeProject.readyCount / activeProject.entryCount) * 100) : 0}% complete</small></div>
                <div><span>Characters</span><strong>{activeProject.characters.length.toLocaleString()}</strong><small>Voice assignments</small></div>
                <div className={activeProject.errorCount ? "has-errors" : ""}><span>Needs attention</span><strong>{activeProject.errorCount.toLocaleString()}</strong><small>{activeProject.queuedCount ? `${activeProject.queuedCount} queued` : "Queue is clear"}</small></div>
              </div>

              {queueRunning && (
                <div className="queue-banner">
                  <span className="queue-orbit"><WandSparkles size={17} /></span>
                  <div><strong>Generating {queueProgress.current.toLocaleString()} of {queueProgress.total.toLocaleString()}</strong><small>{queueProgress.label}</small></div>
                  <div className="queue-track"><span style={{ width: `${queueProgress.total ? (queueProgress.current / queueProgress.total) * 100 : 0}%` }} /></div>
                  <button onClick={() => queueAbortRef.current?.abort()}><CirclePause size={16} /> Pause safely</button>
                </div>
              )}

              <div className="entries-toolbar">
                <div className="entry-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search ID, scene, character, or text…" /></div>
                <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} aria-label="Filter by status">
                  <option value="all">All statuses</option><option value="pending">Pending</option><option value="queued">Queued</option><option value="ready">Ready</option><option value="review">Review</option><option value="error">Errors</option>
                </select>
                <select value={sceneFilter} onChange={(event) => { setSceneFilter(event.target.value); setPage(1); }} aria-label="Filter by scene">
                  <option value="all">All scenes</option>{scenes.map((scene) => <option key={scene} value={scene}>{scene}</option>)}
                </select>
                <div className="generation-actions">
                  {resumableIds.length > 0 && !queueRunning && <button className="resume-button" onClick={() => void runQueue(resumableIds)}><Play size={15} /> Resume {resumableIds.length.toLocaleString()}</button>}
                  {selected.size > 0 ? <button className="generate-selected" onClick={() => void runQueue([...selected])} disabled={queueRunning}><WandSparkles size={15} /> Generate selected ({selected.size})</button>
                    : <button className="generate-selected" onClick={() => void runQueue(pendingIds)} disabled={queueRunning || !pendingIds.length}><WandSparkles size={15} /> Generate pending ({pendingIds.length.toLocaleString()})</button>}
                </div>
              </div>

              <div className="entries-table-wrap">
                <table className="entries-table">
                  <thead><tr><th><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected((current) => { const next = new Set(current); visibleEntries.forEach((entry) => allVisibleSelected ? next.delete(entry.id) : next.add(entry.id)); return next; })} aria-label="Select visible entries" /></th><th>ID / SCENE</th><th>CHARACTER</th><th>DIALOGUE</th><th>VOICE</th><th>STATUS</th><th /></tr></thead>
                  <tbody>
                    {visibleEntries.map((entry) => (
                      <tr key={entry.id} className={selected.has(entry.id) ? "selected" : ""}>
                        <td><input type="checkbox" checked={selected.has(entry.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })} aria-label={`Select ${entry.externalId}`} /></td>
                        <td><strong>{entry.externalId}</strong><small>{entry.scene || "Unassigned scene"}</small></td>
                        <td><span className="speaker-avatar">{entry.speaker.slice(0, 1).toUpperCase()}</span><span>{entry.speaker}</span></td>
                        <td className="dialogue-cell"><p>{entry.text}</p><small>{entry.text.split(/\s+/).length} words · {entry.locale}</small></td>
                        <td><span className="voice-name">{entry.voice}</span></td>
                        <td><span className={`entry-status ${entry.status}`}>{entry.status === "ready" && <Check size={11} />}{entry.status}</span>{entry.error && <small className="row-error" title={entry.error}>Retry available</small>}</td>
                        <td><div className="row-actions">{entry.hasAudio && <button onClick={() => { const audio = new Audio(`/api/projects/${activeProject.id}/entries/${entry.id}/audio`); void audio.play(); }} aria-label={`Play ${entry.externalId}`}><Play size={14} /></button>}<button onClick={() => setEditingEntry({ ...entry })} aria-label={`Edit ${entry.externalId}`}><Pencil size={14} /></button></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visibleEntries.length && <div className="no-entries"><FileUp size={23} /><strong>{activeProject.entries.length ? "No lines match these filters" : "Import your dialogue source"}</strong><span>CSV, TSV, JSON, SyncVoice JSON, and plain text are supported.</span></div>}
              </div>

              <div className="table-footer">
                <span>Showing {visibleEntries.length ? ((page - 1) * PAGE_SIZE + 1).toLocaleString() : 0}–{Math.min(page * PAGE_SIZE, filteredEntries.length).toLocaleString()} of {filteredEntries.length.toLocaleString()}</span>
                <div><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1}>Previous</button><span>Page {page} / {pageCount}</span><button onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page === pageCount}>Next</button></div>
              </div>

              <div className="project-handoff">
                <div><Settings2 size={18} /><span><strong>Portable by design</strong><small>Stable IDs, casting, and dialogue can move between collaborators without generated audio.</small></span></div>
                <div><button onClick={exportProjectSource}><Download size={15} /> Export project source</button><input ref={projectImportRef} type="file" hidden accept=".json,.syncvoice" onChange={(event) => event.target.files?.[0] && void importEntries(event.target.files[0])} /><button onClick={() => projectImportRef.current?.click()}><FileUp size={15} /> Import project source</button></div>
              </div>
            </>
          )}
        </section>
      </div>

      {showNewProject && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowNewProject(false)}>
          <div className="project-modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
            <button className="modal-close" onClick={() => setShowNewProject(false)} aria-label="Close"><X size={18} /></button>
            <span className="modal-icon"><FolderKanban size={23} /></span><span className="section-kicker">NEW PROJECT</span>
            <h2 id="new-project-title">Start with a durable workspace.</h2><p>Import now or later. Dialogue IDs remain stable across every generation and release.</p>
            <label>Project name<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Echoes of Aether" onKeyDown={(event) => event.key === "Enter" && void createProject()} /></label>
            <label>Target engine<select value={newProjectEngine} onChange={(event) => setNewProjectEngine(event.target.value)}><option value="universal">Universal manifest</option><option value="unity">Unity</option><option value="unreal">Unreal Engine</option><option value="godot">Godot</option><option value="custom">Custom engine</option></select></label>
            <button className="primary-project-button" onClick={() => void createProject()} disabled={!newProjectName.trim()}><Plus size={17} /> Create project</button>
          </div>
        </div>
      )}

      {showCasting && activeProject && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowCasting(false)}>
          <aside className="casting-drawer" aria-label="Character voice casting">
            <div className="drawer-head"><div><span className="section-kicker">VOICE BIBLE</span><h2>Cast every character once.</h2><p>Changes apply to every matching dialogue entry and only invalidate audio that actually changed.</p></div><button onClick={() => setShowCasting(false)}><X size={19} /></button></div>
            <div className="cast-list">
              {activeProject.characters.map((character) => {
                const draft = castChanges[character.id] ?? { voice: character.voice, direction: character.direction };
                return <div className="cast-card" key={character.id}><span className="cast-avatar">{character.name.slice(0, 1).toUpperCase()}</span><div className="cast-fields"><strong>{character.name}</strong><div><select value={draft.voice} onChange={(event) => setCastChanges((changes) => ({ ...changes, [character.id]: { ...draft, voice: event.target.value } }))}>{VOICES.map((voice) => <option key={voice}>{voice}</option>)}</select><input value={draft.direction} onChange={(event) => setCastChanges((changes) => ({ ...changes, [character.id]: { ...draft, direction: event.target.value } }))} placeholder="Calm, guarded, quietly amused…" /></div></div><button onClick={() => void applyCasting(character)}>Apply</button></div>;
              })}
            </div>
          </aside>
        </div>
      )}

      {editingEntry && activeProject && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditingEntry(null)}>
          <aside className="entry-drawer" aria-label="Edit dialogue entry">
            <div className="drawer-head"><div><span className="section-kicker">DIALOGUE ENTRY</span><h2>{editingEntry.externalId}</h2><p>Changing dialogue, locale, direction, or voice automatically marks its audio for regeneration.</p></div><button onClick={() => setEditingEntry(null)}><X size={19} /></button></div>
            <div className="entry-form-grid">
              <label>Stable ID<input value={editingEntry.externalId} onChange={(event) => setEditingEntry({ ...editingEntry, externalId: event.target.value })} /></label>
              <label>Scene<input value={editingEntry.scene} onChange={(event) => setEditingEntry({ ...editingEntry, scene: event.target.value })} /></label>
              <label>Character<input value={editingEntry.speaker} onChange={(event) => setEditingEntry({ ...editingEntry, speaker: event.target.value })} /></label>
              <label>Voice<select value={editingEntry.voice} onChange={(event) => setEditingEntry({ ...editingEntry, voice: event.target.value })}>{VOICES.map((voice) => <option key={voice}>{voice}</option>)}</select></label>
              <label className="full">Dialogue<textarea value={editingEntry.text} onChange={(event) => setEditingEntry({ ...editingEntry, text: event.target.value })} /></label>
              <label className="full">Performance direction<input value={editingEntry.direction} onChange={(event) => setEditingEntry({ ...editingEntry, direction: event.target.value })} placeholder="Whispered, urgent, holding back tears…" /></label>
              {editingEntry.hasAudio && <div className="entry-audio full"><audio controls src={`/api/projects/${activeProject.id}/entries/${editingEntry.id}/audio`} /><span>{editingEntry.durationMs ? `${(editingEntry.durationMs / 1000).toFixed(1)} seconds` : "Generated audio"}</span></div>}
            </div>
            <div className="drawer-footer"><button className="danger-text" onClick={async () => { if (!confirm(`Delete ${editingEntry.externalId}?`)) return; await api(`/api/projects/${activeProject.id}/entries/${editingEntry.id}`, { method: "DELETE" }); setEditingEntry(null); await refreshActive(); }}><Trash2 size={15} /> Delete entry</button><button className="primary-project-button" onClick={() => void saveEntry()}><Check size={16} /> Save changes</button></div>
          </aside>
        </div>
      )}

      {(notice || error) && <div className={`project-toast ${error ? "error" : ""}`}><span>{error || notice}</span><button onClick={() => { setNotice(null); setError(null); }}><X size={15} /></button></div>}
    </main>
  );
}
