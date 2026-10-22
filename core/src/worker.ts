// Worker: drains batch/stream queues, calls the loaded tool sidecar over
// HTTP, appends chunk/waveform/transcript/take events. No fake results:
// when the sidecar is unreachable the job goes to error with an actionable note.
// Audio sidecars speak POST {base}/infer (JSON) with {prompt, ref_id, seed}.
// URLs come from env.
import type { Queue } from "./queue.js";
import type { Store } from "./store.js";
import { parsePromptTags } from "./tags.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gain, pitch, readWav16, spectrum, writeWav16 } from "./fx.js";
import { gpuStatus } from "./gpu.js";
import { gpuFree } from "./gpuwait.js";
import { registry } from "./tools.js";
import type { Job } from "./types.js";

export function dataDirs(): { base: string; uploads: string; fxout: string } {
  const base = dirname(process.env.DATA_PATH ?? "data/jobs.db");
  const uploads = join(base, "uploads");
  const fxout = join(base, "fx-out");
  mkdirSync(uploads, { recursive: true });
  mkdirSync(fxout, { recursive: true });
  return { base, uploads, fxout };
}

function resolveUpload(ref: string): string {
  if (!ref.startsWith("upload:")) throw new Error(`bad input ref ${JSON.stringify(ref)} (want upload:<file>)`);
  const file = basename(ref.slice("upload:".length));
  if (!file || file.includes("..")) throw new Error(`bad input ref ${JSON.stringify(ref)}`);
  const path = join(dataDirs().uploads, file);
  if (!existsSync(path)) throw new Error(`upload not found: ${file}`);
  return path;
}

// CPU-native tools: pure-TS DSP in-process. No sidecar, no VRAM.
async function runLocal(toolId: string, job: Job, store: Store): Promise<void> {
  const ref = job.input_refs[0];
  if (!ref) throw new Error(`${toolId} needs input_refs[0] = upload:<file>. POST /v1/uploads first.`);
  const pcm = readWav16(readFileSync(resolveUpload(ref)));
  store.updateJob(job.id, { status: "active" });
  if (toolId === "fx-spectrum") {
    const spec = spectrum(pcm);
    const summary = spec.peaks.map((p) => `${Math.round(p.hz)}Hz`).join(", ") || "no peaks";
    store.appendEvent(job.id, "transcript", { text: `peaks: ${summary}` });
    store.appendEvent(job.id, "take", { spectrum: spec });
  } else if (toolId === "fx-tuner") {
    const p = pitch(pcm);
    const sign = p.cents >= 0 ? "+" : "";
    store.appendEvent(job.id, "transcript", {
      text: `${p.note} ${sign}${p.cents}c @ ${p.hz}Hz`,
    });
    store.appendEvent(job.id, "take", { pitch: p });
  } else if (toolId === "fx-gain") {
    let opts: { db?: unknown; normalize?: unknown; fadeInSec?: unknown; fadeOutSec?: unknown };
    try {
      opts = JSON.parse(job.prompt ?? "{}");
    } catch {
      throw new Error('fx-gain prompt must be JSON like {"db": 6}');
    }
    if (typeof opts.db !== "number" || !Number.isFinite(opts.db)) {
      throw new Error('fx-gain prompt must be JSON like {"db": 6}');
    }
    const out = gain(pcm, {
      db: opts.db,
      normalize: opts.normalize === true,
      fadeInSec: typeof opts.fadeInSec === "number" ? opts.fadeInSec : undefined,
      fadeOutSec: typeof opts.fadeOutSec === "number" ? opts.fadeOutSec : undefined,
    });
    const fname = `take-${Date.now()}-fx.wav`;
    writeFileSync(join(dataDirs().fxout, fname), writeWav16(out.sr, out.data));
    store.updateJob(job.id, { artifact_refs: [fname] });
    store.appendEvent(job.id, "waveform", { ref: fname });
  } else {
    throw new Error(`unknown local tool ${toolId}`);
  }
  store.appendEvent(job.id, "done", { tool_id: toolId });
  store.updateJob(job.id, { status: "done" });
}

export interface SidecarResult {
  audio_ref?: string;
  transcript?: string;
  take?: unknown;
  chunks?: number;
  ref_used?: string | null;
}

function sidecarBase(toolId: string): string | null {
  if (toolId === "tts-fish-s1mini") return process.env.FISH_URL ?? null;
  if (toolId === "tts-qwen3-0.6B")
    return process.env.QWEN_URL ?? process.env.TTS_URL ?? null;
  if (toolId === "tts-kokoro-82M")
    return process.env.KOKORO_URL ?? process.env.TTS_URL ?? null;
  if (toolId === "tts-cpm2")
    return process.env.CPM_URL ?? process.env.TTS_URL ?? null;
  if (toolId.startsWith("music-"))
    return process.env.MUSIC_URL ?? null;
  if (toolId.startsWith("sfx-"))
    return process.env.SFX_URL ?? process.env.MUSIC_URL ?? null;
  if (toolId.startsWith("provider-")) return process.env.PROVIDER_URL ?? null;
  return process.env.GENERIC_SIDECAR_URL ?? null;
}

// Per-family sidecar budgets (Optic unlimited.ts timeout pattern). A hung
// sidecar must fail the job, not wedge the poll loop. Overridable via
// CORE_SIDECAR_TIMEOUT_MS for tests.
function sidecarTimeoutMs(toolId: string): number {
  const override = Number(process.env.CORE_SIDECAR_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  if (toolId.startsWith("music-") || toolId.startsWith("sfx-")) return 10 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function callAudio(
  toolId: string,
  base: string,
  body: { prompt: string | null; ref_id: string | null; seed: number | null },
): Promise<SidecarResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), sidecarTimeoutMs(toolId));
  try {
    const res = await fetch(`${base}/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sidecar ${res.status}`);
    return (await res.json()) as SidecarResult;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`sidecar timed out after ${Math.round(sidecarTimeoutMs(toolId) / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Jobs already announced as waiting (one event per job, no spam).
const waiting = new Set<string>();

export async function processNext(
  queue: Queue,
  store: Store,
  gpuCheck: (needGb: number) => Promise<{ free: boolean; usedMiB: number; needMiB: number }> = gpuFree,
): Promise<boolean> {  const next = queue.dequeue();
  if (!next) return false;
  const job = store.getJob(next.jobId);
  if (!job || job.status !== "queued") return true;
  const manifest = registry.get(job.tool_id);
  if (!manifest) {
    store.updateJob(job.id, { status: "error", error: `unknown tool ${job.tool_id}` });
    return true;
  }
  if (manifest.backend !== "api" && !gpuStatus().loaded.includes(job.tool_id)) {
    store.updateJob(job.id, {
      status: "error",
      error: `tool ${job.tool_id} not loaded. POST /v1/tools/${job.tool_id}/load first.`,
    });
    store.appendEvent(job.id, "status", { status: "error", reason: "tool-not-loaded" });
    return true;
  }
  // Shared-GPU gate (v1 queue-and-wait): if the other project holds VRAM
  // such that our model would breach the 7GB cap, requeue silently and
  // retry on the next poll. One waiting event per job to avoid log spam.
  // Skipped for zero-VRAM tools (cpu/api) and with CORE_GPU_WAIT=0, which is
  // correct iff all sidecars are stubs. Test scripts and compose set it;
  // native production with real models leaves it unset and truly waits.
  // Live-test lesson: nvidia-smi counts OUR sidecars too, so when the
  // job's own sidecar reports loaded:true its VRAM is already resident and
  // the wait is skipped (otherwise a resident model would wait on itself).
  if (manifest.vram_gb > 0 && process.env.CORE_GPU_WAIT !== "0") {
    const base = sidecarBase(job.tool_id);
    let resident = false;
    if (base) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        try {
          const res = await fetch(`${base}/health`, { signal: ctrl.signal });
          const h = (await res.json().catch(() => ({}))) as { loaded?: unknown };
          resident = res.ok && h.loaded === true;
        } finally {
          clearTimeout(t);
        }
      } catch {
        resident = false;
      }
    }
    if (!resident) {
      const gate = await gpuCheck(manifest.vram_gb);
      if (!gate.free) {
        if (!waiting.has(job.id)) {
          waiting.add(job.id);
          store.appendEvent(job.id, "status", {
            status: "queued",
            reason: "waiting-gpu",
            used_mib: gate.usedMiB,
            need_mib: gate.needMiB,
          });
        }
        queue.enqueue(next.queue, next.jobId);
        return true;
      }
    }
    waiting.delete(job.id);
  }
  // CPU-native tools run DSP in-process: no sidecar, no VRAM, no wait.
  if (manifest.backend === "local") {
    try {
      await runLocal(job.tool_id, job, store);
    } catch (err) {
      store.updateJob(job.id, { status: "error", error: (err as Error).message });
      store.appendEvent(job.id, "status", { status: "error", reason: "fx-failed" });
    }
    return true;
  }
  const base = sidecarBase(job.tool_id);
  if (!base) {
    const hint =
      job.tool_id === "tts-fish-s1mini"
        ? "Set FISH_URL to a running Fish S1-mini sidecar (tools/tts-fish-s1mini server)."
          : job.tool_id === "tts-qwen3-0.6B"
            ? "Set QWEN_URL to a running Qwen3 sidecar (tools/tts-qwen3 server)."
            : job.tool_id === "tts-cpm2"
              ? "Set CPM_URL to a running CPM2 sidecar (tools/tts-cpm2 server)."
          : job.tool_id.startsWith("music-")
            ? "Set MUSIC_URL to a running MusicGen sidecar (tools/music-musicgen-small server)."
            : job.tool_id.startsWith("sfx-")
              ? "Set SFX_URL to a running Bark sidecar (tools/sfx-bark server)."
              : "Set TTS_URL / MUSIC_URL / SFX_URL / PROVIDER_URL to a running audio sidecar.";
    store.updateJob(job.id, { status: "error", error: `sidecar offline. ${hint}` });
    store.appendEvent(job.id, "status", { status: "error", reason: "sidecar-offline" });
    return true;
  }
  try {
    store.updateJob(job.id, { status: "active" });
    store.appendEvent(job.id, "status", { status: "active", tool_id: job.tool_id });
    // Prompt direction markers (fish emotion tags etc.) become take
    // metadata so clients and /result can show what was asked for.
    if (job.tool_id.startsWith("tts-") && job.prompt) {
      const { tags, unknown } = parsePromptTags(job.prompt, job.tool_id);
      if (tags.length || unknown.length) {
        store.appendEvent(job.id, "take", { prompt_tags: tags, unknown_markers: unknown });
      }
    }
    const out = await callAudio(job.tool_id, base, {
      prompt: job.prompt,
      ref_id: job.ref_id,
      seed: job.seed,
    });
    if (out.transcript)
      store.appendEvent(job.id, "transcript", { text: out.transcript });
    if (out.audio_ref) {
      store.updateJob(job.id, { artifact_refs: [out.audio_ref] });
      store.appendEvent(job.id, "waveform", { ref: out.audio_ref });
    }
    if (out.take) store.appendEvent(job.id, "take", out.take);
    if (out.ref_used) store.appendEvent(job.id, "take", { ref_used: out.ref_used });
    if (out.chunks) store.appendEvent(job.id, "chunk", { chunks: out.chunks });
    store.appendEvent(job.id, "done", { tool_id: job.tool_id });
    store.updateJob(job.id, { status: "done" });
  } catch (err) {
    store.updateJob(job.id, { status: "error", error: `sidecar call failed: ${(err as Error).message}` });
    store.appendEvent(job.id, "status", { status: "error", reason: "sidecar-call-failed" });
  }
  return true;
}

export function startWorker(queue: Queue, store: Store, ms = 500): () => void {
  if (process.env.WORKER === "0") return () => {};
  const t = setInterval(() => {
    processNext(queue, store).catch(() => {});
  }, ms);
  (t as unknown as { unref(): void }).unref?.();
  return () => clearInterval(t);
}
