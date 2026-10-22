import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GpuStatus, type Job, type JobResult, type ToolManifest } from "./api";

interface Ev { type: string; data: string }

const isTts = (t: ToolManifest) => t.id.startsWith("tts-");
const isFx = (t: ToolManifest) => t.id.startsWith("fx-");
const short = (id: string) => id.slice(0, 8);

export default function App() {
  const [tools, setTools] = useState<ToolManifest[]>([]);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<"synth" | "fx" | "refs" | "takes">("synth");
  const [toolId, setToolId] = useState("tts-fish-s1mini");
  const [prompt, setPrompt] = useState("hello, this is a test take");
  const [refId, setRefId] = useState("");
  const [gainDb, setGainDb] = useState("6");
  const [fxId, setFxId] = useState("fx-tuner");
  const [upRef, setUpRef] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [takes, setTakes] = useState<string[]>([]);
  const [result, setResult] = useState<JobResult | null>(null);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const refFileRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, g, r, j] = await Promise.all([
        api.tools(), api.gpu(), api.refs().catch(() => ({ refs: [] as string[] })), api.jobs().catch(() => [] as Job[]),
      ]);
      setTools(t); setGpu(g); setRefs(r.refs); setJobs(j);
      if (!t.find((x) => x.id === toolId) && t[0]) setToolId(t[0].id);
    } catch (e) { setErr(String((e as Error).message)); }
  }, [toolId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => esRef.current?.close(), []);

  const watch = useCallback(async (id: string) => {
    esRef.current?.close();
    setEvents([]); setTakes([]); setResult(null);
    const j = jobs.find((x) => x.id === id);
    if (j) setJob(j);
    const es = new EventSource(`/v1/jobs/${id}/events`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = (ev as MessageEvent).data as string;
      setEvents((p) => [{ type: "msg", data }, ...p].slice(0, 60));
      try {
        const d = JSON.parse(data) as { ref?: string };
        if (d.ref) setTakes((p) => (p.includes(d.ref as string) ? p : [...p, d.ref as string]));
      } catch { /* non-JSON chunk */ }
    };
    es.addEventListener("done", () => {
      es.close();
      api.result(id).then(setResult).catch(() => {});
      void refresh();
    });
  }, [jobs, refresh]);

  const openJob = useCallback((id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (j) setJob(j);
    void watch(id);
  }, [jobs, watch]);

  const run = useCallback(async (body: Parameters<typeof api.createJob>[0]) => {
    setErr("");
    try {
      await api.loadTool(body.tool_id);
      const j = await api.createJob(body);
      setJob(j);
      await watch(j.id);
      void refresh();
    } catch (e) { setErr(String((e as Error).message)); }
  }, [watch, refresh]);

  const retry = useCallback(async () => {
    if (!job) return;
    setErr("");
    try {
      const c = await api.retry(job.id);
      setJob(c);
      await watch(c.id);
      void refresh();
    } catch (e) { setErr(String((e as Error).message)); }
  }, [job, watch, refresh]);

  const pickFile = () => fileRef.current?.click();
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    try {
      const u = await api.upload(f.name, f);
      setUpRef(u.ref);
      await run({ tool_id: fxId, mode: "batch", prompt: fxId === "fx-gain" ? JSON.stringify({ db: Number(gainDb) || 0 }) : "analyze", input_refs: [u.ref] });
    } catch (e) { setErr(String((e as Error).message)); }
  };

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 720, margin: "1.5rem auto", padding: "0 1rem" }}>
      <h1>Syrinx</h1>
      <div style={{ color: "#666", fontSize: 13 }}>
        gpu {gpu ? `${gpu.used_gb}/${gpu.cap_gb}GB [${gpu.loaded.join(", ") || "idle"}]` : "…"} ·
        cpu tools never block · <button onClick={() => void refresh()}>refresh</button>
      </div>
      {err && <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}
      <div style={{ margin: "1rem 0" }}>
        {(["synth", "fx", "refs", "takes"] as const).map((t) => (
          <button key={t} disabled={tab === t} onClick={() => setTab(t)} style={{ marginRight: 8 }}>{t}</button>
        ))}
      </div>

      {tab === "synth" && (
        <div>
          <select value={toolId} onChange={(e) => setToolId(e.target.value)}>
            {tools.filter(isTts).map((t) => (
              <option key={t.id} value={t.id}>{t.id} [{t.device}{t.vram_gb ? ` ${t.vram_gb}GB` : ""}]</option>
            ))}
          </select>
          <div style={{ color: "#666", fontSize: 12 }}>{tools.find((t) => t.id === toolId)?.description}</div>
          <textarea rows={3} cols={70} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <select value={refId} onChange={(e) => setRefId(e.target.value)}>
              <option value="">random voice</option>
              {refs.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button onClick={() => void run({ tool_id: toolId, mode: "stream", prompt, ref_id: refId || null })}>
              Synthesize
            </button>
          </div>
        </div>
      )}

      {tab === "fx" && (
        <div>
          <p style={{ fontSize: 13 }}>CPU-native DSP. Pick a wav, it uploads then runs the selected tool.</p>
          <input ref={fileRef} type="file" accept=".wav,audio/wav" style={{ display: "none" }}
            onChange={(e) => void onFile(e.target.files?.[0])} />
          <select value={fxId} onChange={(e) => setFxId(e.target.value)}>
            {tools.filter(isFx).map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          {" "}gain dB <input value={gainDb} onChange={(e) => setGainDb(e.target.value)} size={4} />
          {" "}<button onClick={pickFile}>Choose wav + run</button>
          {upRef && <div style={{ fontSize: 12 }}>input: {upRef}</div>}
        </div>
      )}

      {tab === "refs" && (
        <div>
          <input ref={refFileRef} type="file" accept=".wav,audio/wav" style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const id = window.prompt("ref_id?", f.name.replace(/\W+/g, "_"));
              const tx = id && window.prompt("transcript of the reference?", "");
              if (!id || !tx) return;
              try { await api.uploadRef(id, tx, f); setRefs((p) => [...new Set([...p, id])]); }
              catch (er) { setErr(String((er as Error).message)); }
            }} />
          <button onClick={() => refFileRef.current?.click()}>Upload reference voice</button>
          <ul>{refs.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {tab === "takes" && (
        <div>
          <p style={{ fontSize: 13 }}>Job history. Open one to compare its takes, retry for another take.</p>
          <select value={job?.id ?? ""} onChange={(e) => e.target.value && openJob(e.target.value)}>
            <option value="">— pick a job —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {short(j.id)} · {j.tool_id} · {j.status}{j.parent_id ? " · retry" : ""}
              </option>
            ))}
          </select>
          {job && (
            <button onClick={() => void retry()} style={{ marginLeft: 8 }}>
              Retry (new take)
            </button>
          )}
        </div>
      )}

      {job && <div style={{ marginTop: 12, fontSize: 13 }}>job {job.id} · {job.tool_id} · {job.status}</div>}
      {takes.map((ref, i) => (
        <div key={ref} style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12 }}>take {i + 1} · {ref}</div>
          <audio controls src={`/v1/audio/${ref}`} style={{ width: "100%" }} />
        </div>
      ))}
      {result && (
        <pre style={{ background: "#eef6ee", padding: 8, whiteSpace: "pre-wrap", fontSize: 12 }}>
          result: {result.transcript ?? "—"}
          {result.analysis && Object.keys(result.analysis).length > 0 && `\nanalysis: ${JSON.stringify(result.analysis)}`}
          {result.children.length > 0 && `\nretries: ${result.children.map(short).join(", ")}`}
        </pre>
      )}
      <pre style={{ background: "#f4f4f4", padding: 8, whiteSpace: "pre-wrap", fontSize: 12 }}>
        {events.map((e) => e.data).join("\n") || "events…"}
      </pre>
    </div>
  );
}
