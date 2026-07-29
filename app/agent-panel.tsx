"use client";

import { Bot, CheckCircle2, CircleAlert, FolderSearch2, LoaderCircle, Play, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type AgentEvent = { type: string; message: string; at: number };
type AgentJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  events: AgentEvent[];
  error: string | null;
  output?: { model?: string; result?: { summary?: string; entriesDiscovered?: number; filesChanged?: string[]; warnings?: string[]; nextActions?: string[] } } | null;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:4319";

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [envPath, setEnvPath] = useState("");
  const [mission, setMission] = useState("Discover every spoken line, prepare durable voice assets, integrate synchronized playback, and preserve the current fallback behavior.");
  const [connected, setConnected] = useState(false);
  const [job, setJob] = useState<AgentJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openPanel() {
    setEndpoint(localStorage.getItem("syncvoice.agent.endpoint") || DEFAULT_ENDPOINT);
    setToken(localStorage.getItem("syncvoice.agent.token") || "");
    setWorkspace(localStorage.getItem("syncvoice.agent.workspace") || "");
    setEnvPath(localStorage.getItem("syncvoice.agent.envPath") || "");
    setOpen(true);
  }

  const request = useCallback(async <T,>(path: string, options?: RequestInit) => {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options?.headers },
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Companion request failed (${response.status}).`);
    return payload;
  }, [endpoint, token]);

  async function connect() {
    setBusy(true); setError(null);
    try {
      await request<{ ok: boolean }>("/health");
      localStorage.setItem("syncvoice.agent.endpoint", endpoint);
      localStorage.setItem("syncvoice.agent.token", token);
      setConnected(true);
    } catch (caught) { setConnected(false); setError(caught instanceof Error ? caught.message : "Could not connect to the local companion."); }
    finally { setBusy(false); }
  }

  async function run(mode: "plan" | "apply" | "generate") {
    if (!workspace.trim()) { setError("Choose the game repository folder first."); return; }
    if (mode === "generate" && !envPath.trim()) { setError("Choose the local environment file containing the Gemini keys."); return; }
    setBusy(true); setError(null);
    try {
      localStorage.setItem("syncvoice.agent.workspace", workspace);
      if (envPath) localStorage.setItem("syncvoice.agent.envPath", envPath);
      const created = await request<AgentJob>("/jobs", { method: "POST", body: JSON.stringify({ mode, workspace, mission, envPath, concurrency: 4 }) });
      setJob(created); setConnected(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start the Production Agent."); }
    finally { setBusy(false); }
  }

  async function pause() {
    if (!job) return;
    try { setJob(await request<AgentJob>(`/jobs/${job.id}/cancel`, { method: "POST" })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not pause the job."); }
  }

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void request<AgentJob>(`/jobs/${job.id}`).then(setJob).catch((caught) => setError(caught instanceof Error ? caught.message : "Lost contact with the companion."));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [job, request]);

  const latestEvents = useMemo(() => job?.events.slice(-8) ?? [], [job]);

  return (
    <>
      <button className="agent-launch" onClick={openPanel}><Bot size={15} /> Production agent</button>
      {open && (
        <div className="agent-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="agent-panel" role="dialog" aria-modal="true" aria-labelledby="agent-title">
            <header>
              <span className="agent-symbol"><Bot size={23} /></span>
              <div><span className="section-kicker">CODEX COMPANION</span><h2 id="agent-title">Give voice production to an agent.</h2><p>It audits a local game repository, prepares an incremental asset manifest, integrates playback, and validates its own changes.</p></div>
              <button className="agent-close" onClick={() => setOpen(false)} aria-label="Close"><X size={18} /></button>
            </header>

            <div className="agent-security"><ShieldCheck size={17} /><span><strong>Local and least privilege</strong><small>Your source stays on this computer. Analysis is read-only; Apply is restricted to the selected Git repository.</small></span></div>

            {!connected ? (
              <div className="agent-connect">
                <div><label>Companion address<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><label>Pairing token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Shown by npm run agent" /></label></div>
                <button onClick={() => void connect()} disabled={busy || !token}>{busy ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />} Connect companion</button>
                <p>Run <code>npm run agent</code> in the SyncVoice folder, then paste the one-time pairing token shown in that window.</p>
              </div>
            ) : (
              <div className="agent-workspace">
                <label>Game repository<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="D:\Projects\MyGame" /></label>
                <label>Production mission<textarea value={mission} onChange={(event) => setMission(event.target.value)} /></label>
                <label>Gemini keys file <span>(generation only)</span><input value={envPath} onChange={(event) => setEnvPath(event.target.value)} placeholder="D:\secure\tts.env" /></label>
                <div className="agent-actions">
                  <button onClick={() => void run("plan")} disabled={busy || job?.status === "running"}><FolderSearch2 size={16} /> Analyze safely</button>
                  <button className="agent-apply" onClick={() => void run("apply")} disabled={busy || job?.status === "running"}><Play size={16} /> Apply production plan</button>
                  <button className="agent-generate" onClick={() => void run("generate")} disabled={busy || job?.status === "running"}><Bot size={16} /> Generate assets</button>
                </div>
              </div>
            )}

            {error && <div className="agent-error"><CircleAlert size={16} />{error}</div>}
            {job && (
              <div className="agent-run">
                <div className="agent-run-head"><span className={`agent-run-state ${job.status}`}>{job.status === "running" && <LoaderCircle className="spin" size={13} />}{job.status}</span>{job.status === "running" ? <button onClick={() => void pause()}>Pause safely</button> : job.output?.result?.entriesDiscovered !== undefined && <span>{job.output.result.entriesDiscovered.toLocaleString()} entries discovered</span>}</div>
                <div className="agent-events">{latestEvents.map((event, index) => <div key={`${event.at}-${index}`}><i /><span>{event.message}</span></div>)}</div>
                {job.output?.result?.summary && <div className="agent-result"><strong>Agent handoff</strong><p>{job.output.result.summary}</p>{Boolean(job.output.result.filesChanged?.length) && <small>{job.output.result.filesChanged!.length} files changed</small>}</div>}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
