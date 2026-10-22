import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createMemoryQueue } from "./queue.js";
import { createMemoryStore } from "./store.js";
import { loadTool, unloadAll } from "./gpu.js";
import { processNext } from "./worker.js";
import type { Job } from "./types.js";

function job(id: string, mode: Job["mode"] = "stream"): Job {
  const t = new Date().toISOString();
  return {
    id, owner_id: "local", tool_id: "tts-fish-s1mini", mode,
    status: "queued", parent_id: null, prompt: "hello world", ref_id: null, seed: 7,
    input_refs: [], artifact_refs: [], error: null,
    idempotency_key: null, created_at: t, updated_at: t,
  };
}

// Shared-GPU gate is injectable: unit tests never touch real nvidia-smi.
const gpuFree = async () => ({ free: true, usedMiB: 0, needMiB: 5120 });
const gpuBusy = async () => ({ free: false, usedMiB: 3161, needMiB: 5120 });

describe("worker", () => {
  it("errors honestly when the sidecar is offline", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    delete process.env.FISH_URL;
    delete process.env.TTS_URL;
    delete process.env.GENERIC_SIDECAR_URL;
    const q = createMemoryQueue();
    const s = createMemoryStore();
    s.createJob(job("a"));
    q.enqueue("stream", "a");
    expect(await processNext(q, s, gpuFree)).toBe(true);
    expect(s.getJob("a")?.status).toBe("error");
    expect(s.getJob("a")?.error).toMatch(/sidecar offline/);
  });

  it("errors when tool not loaded", async () => {
    unloadAll();
    const q = createMemoryQueue();
    const s = createMemoryStore();
    s.createJob(job("b"));
    q.enqueue("stream", "b");
    expect(await processNext(q, s, gpuFree)).toBe(true);
    expect(s.getJob("b")?.error).toMatch(/not loaded/);
  });

  it("calls fish sidecar and streams transcript + done", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    const server = createServer((req, res) => {
      void req.resume().on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ audio_ref: "clips/x.wav", transcript: "hello world", chunks: 3 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    process.env.FISH_URL = `http://127.0.0.1:${port}`;
    try {
      const q = createMemoryQueue();
      const s = createMemoryStore();
      s.createJob(job("c"));
      q.enqueue("stream", "c");
      expect(await processNext(q, s, gpuFree)).toBe(true);
      expect(s.eventsAfter("c", 0).map((e) => e.type)).toEqual(
        expect.arrayContaining(["transcript", "waveform", "done"]),
      );
      expect(s.getJob("c")?.status).toBe("done");
      expect(s.getJob("c")?.artifact_refs).toEqual(["clips/x.wav"]);
    } finally {
      delete process.env.FISH_URL;
      server.close();
    }
  });

  it("requeues while GPU busy, runs when free", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    process.env.FISH_URL = "http://127.0.0.1:1"; // unreachable; busy gate hits first
    try {
      const q = createMemoryQueue();
      const s = createMemoryStore();
      s.createJob(job("d"));
      q.enqueue("stream", "d");
      expect(await processNext(q, s, gpuBusy)).toBe(true);
      expect(s.getJob("d")?.status).toBe("queued");
      expect(
        s.eventsAfter("d", 0).filter((e) => (e.data as { reason?: string })?.reason === "waiting-gpu"),
      ).toHaveLength(1);
      // Second poll while busy: still queued, no second event (no spam).
      expect(await processNext(q, s, gpuBusy)).toBe(true);
      expect(s.getJob("d")?.status).toBe("queued");
      expect(
        s.eventsAfter("d", 0).filter((e) => (e.data as { reason?: string })?.reason === "waiting-gpu"),
      ).toHaveLength(1);
    } finally {
      delete process.env.FISH_URL;
    }
  });

  it("fails honestly when the sidecar hangs (timeout)", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    const server = createServer(() => {
      // Never responds: the worker must time out instead of wedging.
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    process.env.FISH_URL = `http://127.0.0.1:${port}`;
    process.env.CORE_SIDECAR_TIMEOUT_MS = "300";
    try {
      const q = createMemoryQueue();
      const s = createMemoryStore();
      s.createJob(job("e"));
      q.enqueue("stream", "e");
      expect(await processNext(q, s, gpuFree)).toBe(true);
      expect(s.getJob("e")?.status).toBe("error");
      expect(s.getJob("e")?.error).toMatch(/timed out/);
    } finally {
      delete process.env.FISH_URL;
      delete process.env.CORE_SIDECAR_TIMEOUT_MS;
      server.close();
    }
  });

  it("skips the GPU wait when its own sidecar is already resident", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    const server = createServer((req, res) => {
      void req.resume().on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") {
          res.end(JSON.stringify({ ok: true, mode: "stub", loaded: true }));
        } else {
          res.end(JSON.stringify({ audio_ref: "clips/z.wav", transcript: "hi" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    process.env.FISH_URL = `http://127.0.0.1:${port}`;
    try {
      const q = createMemoryQueue();
      const s = createMemoryStore();
      s.createJob(job("g"));
      q.enqueue("stream", "g");
      // GPU busy, but the sidecar already holds the model: must not wait.
      expect(await processNext(q, s, gpuBusy)).toBe(true);
      expect(s.getJob("g")?.status).toBe("done");
      expect(
        s.eventsAfter("g", 0).filter((e) => (e.data as { reason?: string })?.reason === "waiting-gpu"),
      ).toHaveLength(0);
    } finally {
      delete process.env.FISH_URL;
      server.close();
    }
  });

  it("attaches prompt tags as take metadata", async () => {
    unloadAll();
    loadTool("tts-fish-s1mini");
    const server = createServer((req, res) => {
      void req.resume().on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ audio_ref: "clips/y.wav", transcript: "hi" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    process.env.FISH_URL = `http://127.0.0.1:${port}`;
    try {
      const q = createMemoryQueue();
      const s = createMemoryStore();
      const t = new Date().toISOString();
      s.createJob({
        id: "f", owner_id: "local", tool_id: "tts-fish-s1mini", mode: "stream",
        status: "queued", parent_id: null, prompt: "hi (whispering)", ref_id: null, seed: 1,
        input_refs: [], artifact_refs: [], error: null,
        idempotency_key: null, created_at: t, updated_at: t,
      });
      q.enqueue("stream", "f");
      expect(await processNext(q, s, gpuFree)).toBe(true);
      const takes = s.eventsAfter("f", 0).filter((e) => e.type === "take");
      expect(takes.map((e) => e.data)).toEqual(
        expect.arrayContaining([{ prompt_tags: ["whispering"], unknown_markers: [] }]),
      );
    } finally {
      delete process.env.FISH_URL;
      server.close();
    }
  });
});
