import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import type { Job } from "./types.js";
import { createMemoryQueue } from "./queue.js";
import { createSqliteStore } from "./storeSqlite.js";
import { assembleResult } from "./result.js";
import { readWav16 } from "./fx.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gpuStatus, loadTool, unloadTool } from "./gpu.js";
import { registry } from "./tools.js";
import { streamJobEvents } from "./sse.js";
import { startWorker } from "./worker.js";

const app = Fastify({ logger: true });
await app.register(cors);

const queue = createMemoryQueue();
const store = createSqliteStore(process.env.DATA_PATH ?? "data/jobs.db");
// Requeue durable queued jobs after a restart.
for (const j of store.listJobs().filter((x) => x.status === "queued").reverse()) {
  queue.enqueue(j.mode === "stream" ? "stream" : "batch", j.id);
}
const now = () => new Date().toISOString();

function requireAuth(req: unknown, reply: { code(n: number): unknown }): boolean {
  // v1 single-user: permissive hook. Enterprise checks JWT here.
  void req;
  void reply;
  return true;
}

app.get("/v1/health", async () => ({ ok: true, service: "core" }));

// React shell (core/web/dist). Built via `npm --prefix core/web run build`.
// Served by core so one daemon owns UI + API. Falls back to the minimal
// inline player at GET / when dist is absent.
const WEB_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};
function webDir(): string | null {
  if (process.env.CORE_WEB_DIR && existsSync(process.env.CORE_WEB_DIR)) {
    return process.env.CORE_WEB_DIR;
  }
  const here = dirname(fileURLToPath(import.meta.url)); // dist/ or src/
  for (const c of [join(here, "..", "web", "dist"), join(here, "..", "..", "web", "dist")]) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}
app.get("/app/*", async (req, reply) => {
  const dir = webDir();
  if (!dir) return reply.code(404).send({ error: "web not built. Run npm --prefix core/web run build." });
  const rel = ((req.params as { "*": string })["*"] || "index.html").replace(/^\/+/, "");
  const file = join(dir, rel);
  if (!file.startsWith(dir) || !existsSync(file)) {
    return reply.code(404).send({ error: "not found" });
  }
  return reply
    .header("content-type", WEB_MIME[extname(file)] ?? "application/octet-stream")
    .send(readFileSync(file));
});
app.get("/app", async (_req, reply) => reply.redirect("/app/"));

// Minimal test player (no build step). Full React player later, same endpoints.
app.get("/", async (_req, reply) => {
  reply.header("content-type", "text/html").send(`<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:2rem auto">
<h1>Core test player</h1>
<select id="tool"><option>tts-fish-s1mini</option><option>tts-qwen3-0.6B</option><option>tts-kokoro-82M</option></select>
<button onclick="load()">Load</button> <span id="gpu"></span><br><br>
<textarea id="p" rows="3" cols="60">hello, this is a test take</textarea><br>
<button onclick="go()">Synthesize</button> <span id="st"></span>
<pre id="ev" style="background:#f4f4f4;padding:8px;white-space:pre-wrap"></pre>
<audio id="a" controls style="width:100%"></audio>
<script>
async function load(){const t=document.getElementById('tool').value;
 const r=await fetch('/v1/tools/'+t+'/load',{method:'POST'});document.getElementById('gpu').textContent=JSON.stringify(await r.json());}
async function go(){const t=document.getElementById('tool').value;const p=document.getElementById('p').value;
 document.getElementById('st').textContent='queued…';
 const r=await fetch('/v1/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool_id:t,prompt:p})});
 const j=await r.json();if(!r.ok){document.getElementById('st').textContent='error: '+JSON.stringify(j);return;}
 const es=new EventSource('/v1/jobs/'+j.id+'/events');
 es.onmessage=e=>{document.getElementById('ev').textContent+=e.data+'\\n';
  try{const d=JSON.parse(e.data);if(d.ref){document.getElementById('a').src='/v1/audio/'+d.ref;document.getElementById('st').textContent='done';es.close();}}catch{}};
 es.addEventListener('done',()=>{document.getElementById('st').textContent='done';es.close();});}
</script></body></html>`);
});

app.get("/v1/tools", async () => [...registry.values()]);

app.post("/v1/tools/:id/load", async (req, reply) => {
  if (!requireAuth(req, reply)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const res = loadTool(id);
  if (!res.ok) return reply.code(409).send({ error: res.error, gpu: gpuStatus() });
  return { ok: true, gpu: gpuStatus() };
});

app.post("/v1/tools/:id/unload", async (req) => {
  const { id } = req.params as { id: string };
  unloadTool(id);
  return { ok: true, gpu: gpuStatus() };
});

app.get("/v1/gpu", async () => gpuStatus());

app.post("/v1/jobs", async (req, reply) => {
  if (!requireAuth(req, reply)) return reply.code(401).send({ error: "unauthorized" });
  const body = (req.body ?? {}) as Partial<Job>;
  if (!body.tool_id || !registry.has(body.tool_id)) {
    return reply.code(400).send({ error: "unknown tool_id. See GET /v1/tools" });
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return reply.code(400).send({ error: "prompt (string) is required" });
  }
  const job: Job = {
    id: randomUUID(),
    owner_id: "local",
    tool_id: body.tool_id,
    mode: body.mode === "batch" ? "batch" : "stream",
    status: "queued",
    parent_id: null,
    prompt: body.prompt,
    ref_id: body.ref_id ?? null,
    seed: body.seed ?? null,
    input_refs: body.input_refs ?? [],
    artifact_refs: [],
    error: null,
    idempotency_key: (req.headers["idempotency-key"] as string) ?? null,
    created_at: now(),
    updated_at: now(),
  };
  store.createJob(job);
  queue.enqueue(job.mode === "stream" ? "stream" : "batch", job.id);
  store.appendEvent(job.id, "status", { status: job.status, tool_id: job.tool_id });
  return reply.code(201).send(job);
});

// Retry as child job: same tool, optional new prompt/seed/ref. Takes
// compare via parent children[] in GET /result (Optic corrections idea,
// audio-shaped: re-render instead of ROI re-infer).
app.post("/v1/jobs/:id/retry", async (req, reply) => {
  if (!requireAuth(req, reply)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const parent = store.getJob(id);
  if (!parent) return reply.code(404).send({ error: "unknown job" });
  const body = (req.body ?? {}) as Partial<Job>;
  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    return reply.code(400).send({ error: "prompt must be a string" });
  }
  const t = new Date().toISOString();
  const child: Job = {
    id: randomUUID(),
    owner_id: parent.owner_id,
    tool_id: parent.tool_id,
    mode: parent.mode,
    status: "queued",
    parent_id: parent.id,
    prompt: body.prompt ?? parent.prompt ?? "",
    ref_id: body.ref_id ?? parent.ref_id,
    seed: body.seed ?? (parent.seed === null ? Math.floor(Math.random() * 1e9) : parent.seed),
    input_refs: body.input_refs ?? parent.input_refs,
    artifact_refs: [],
    error: null,
    idempotency_key: (req.headers["idempotency-key"] as string) ?? null,
    created_at: t,
    updated_at: t,
  };
  store.createJob(child);
  queue.enqueue(child.mode === "stream" ? "stream" : "batch", child.id);
  store.appendEvent(child.id, "status", { status: child.status, tool_id: child.tool_id, parent_id: parent.id });
  return reply.code(201).send(child);
});

app.get("/v1/jobs", async () => store.listJobs());

app.get("/v1/jobs/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = store.getJob(id);
  if (!job) return reply.code(404).send({ error: "unknown job" });
  return job;
});

// Stable result JSON assembled from the event log (Optic result.ts
// pattern). One shape for automation; the web player uses the same.
app.get("/v1/jobs/:id/result", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = store.getJob(id);
  if (!job) return reply.code(404).send({ error: "unknown job" });
  return assembleResult(store, job);
});

// Live tail: SSE with Last-Event-ID replay. Scales behind any gateway.
app.get("/v1/jobs/:id/events", (req, reply) =>
  streamJobEvents(req as never, reply as never, store),
);

app.post("/v1/jobs/:id/input", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = store.getJob(id);
  if (!job) return reply.code(404).send({ error: "unknown job" });
  store.appendEvent(id, "chunk", { received_at: now(), body: req.body ?? {} });
  return { ok: true };
});

const sidecarBases = () =>
  [
    process.env.FISH_URL,
    process.env.QWEN_URL,
    process.env.TTS_URL,
    process.env.KOKORO_URL,
    process.env.MUSIC_URL,
    process.env.SFX_URL,
    process.env.CPM_URL,
  ].filter((b): b is string => !!b);

// Reference voices for cloning. Stored sidecar-side:
// references/<ref_id>/{sample.wav, sample.lab}. Listed merged across sidecars.
app.post("/v1/refs", async (req, reply) => {
  const body = (req.body ?? {}) as { ref_id?: unknown; transcript?: unknown; wav_b64?: unknown };
  if (typeof body.ref_id !== "string" || typeof body.transcript !== "string" ||
      typeof body.wav_b64 !== "string") {
    return reply.code(400).send({ error: "ref_id, transcript, wav_b64 (all strings) required" });
  }
  const bases = sidecarBases();
  if (!bases.length) return reply.code(404).send({ error: "sidecar offline" });
  // Fan-out: refs are tiny, every sidecar keeps its own copy, so a voice
  // works no matter which tool is resident when the clone job runs.
  const stored: string[] = [];
  let lastErr = "no sidecar accepted the ref";
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/refs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        stored.push(base);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      lastErr = typeof data.error === "string" ? data.error : `sidecar ${res.status}`;
    } catch {
      continue;
    }
  }
  if (!stored.length) return reply.code(502).send({ error: lastErr });
  return { ok: true, ref_id: body.ref_id, stored };
});

app.get("/v1/refs", async () => {  const out = new Map<string, string[]>();
  for (const base of sidecarBases()) {
    try {
      const res = await fetch(`${base}/refs`);
      if (!res.ok) continue;
      const data = (await res.json()) as { refs?: string[] };
      if (Array.isArray(data.refs)) out.set(base, data.refs);
    } catch {
      continue;
    }
  }
  return { refs: [...out.values()].flat(), by_sidecar: [...out.entries()] };
});

// Raw audio upload for CPU fx tools. Validated + stored server-side so
// clone/analyze jobs reference it as input_refs ["upload:<file>"].
app.post("/v1/uploads", async (req, reply) => {
  const body = (req.body ?? {}) as { name?: unknown; wav_b64?: unknown };
  if (typeof body.name !== "string" || typeof body.wav_b64 !== "string") {
    return reply.code(400).send({ error: "name, wav_b64 (strings) required" });
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(body.wav_b64, "base64");
  } catch {
    return reply.code(400).send({ error: "wav_b64 is not valid base64" });
  }
  let seconds = 0;
  try {
    const pcm = readWav16(raw);
    seconds = pcm.data.length / pcm.sr;
  } catch (e) {
    return reply.code(400).send({ error: `invalid wav: ${(e as Error).message}` });
  }
  if (seconds < 0.1 || seconds > 600) {
    return reply.code(400).send({ error: `wav length ${seconds.toFixed(1)}s out of range 0.1-600s` });
  }
  const safe = basename(body.name).replace(/[^a-zA-Z0-9_.-]/g, "_") || "audio.wav";
  const dir = join(dirname(process.env.DATA_PATH ?? "data/jobs.db"), "uploads");
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${safe}`;
  writeFileSync(join(dir, file), raw);
  return { ok: true, ref: `upload:${file}`, seconds: Math.round(seconds * 10) / 10 };
});

app.post("/v1/jobs/:id/cancel", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = store.getJob(id);
  if (!job) return reply.code(404).send({ error: "unknown job" });
  store.updateJob(id, { status: "interrupted" });
  store.appendEvent(id, "status", { status: "interrupted" });
  return { ok: true };
});

app.get("/v1/metrics", async () => ({
  jobs: store.listJobs().length,
  queue: queue.stats(),
  gpu: gpuStatus(),
}));

// Playback via core so web needs only :3001. Proxies sidecar wav.
app.get("/v1/audio/:ref", async (req, reply) => {
  const { ref } = req.params as { ref: string };
  const file = ref.startsWith("upload:") ? ref.slice("upload:".length) : ref;
  if (!/^[\w\-.]+$/.test(file) || file.includes("..")) {
    return reply.code(400).send({ error: "bad ref" });
  }
  const dataDir = dirname(process.env.DATA_PATH ?? "data/jobs.db");
  // Local files first: fx-out takes (take-*-fx.wav) and raw uploads.
  for (const sub of ["fx-out", "uploads"]) {
    const p = join(dataDir, sub, file);
    try {
      const { readFileSync: read } = await import("node:fs");
      return reply.header("content-type", "audio/wav").send(read(p));
    } catch {
      continue;
    }
  }
  const bases = sidecarBases();
  if (!bases.length) return reply.code(404).send({ error: "sidecar offline" });
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/audio/${ref}`);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      return reply.header("content-type", "audio/wav").send(buf);
    } catch {
      continue;
    }
  }
  return reply.code(404).send({ error: "unknown audio" });
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
if (process.env.LISTEN !== "0") {
  startWorker(queue, store);
  app.listen({ port, host });
}
