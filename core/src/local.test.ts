import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sineTake } from "./fx.js";
import { createMemoryQueue } from "./queue.js";
import { createMemoryStore } from "./store.js";
import { loadTool, unloadAll } from "./gpu.js";
import { processNext } from "./worker.js";
import type { Job } from "./types.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "core-fx-"));
  process.env.DATA_PATH = join(dir, "jobs.db");
  process.env.CORE_GPU_WAIT = "0";
  writeFileSync(join(dir, "up.wav"), sineTake(22050, 2, 440));
  // Mimic POST /v1/uploads layout: <data>/uploads/<file>
  mkdirSync(join(dir, "uploads"), { recursive: true });
  copyFileSync(join(dir, "up.wav"), join(dir, "uploads", "up.wav"));
  return dir;
}

function fxJob(id: string, tool_id: string, prompt: string): Job {
  const t = new Date().toISOString();
  return {
    id, owner_id: "local", tool_id, mode: "batch",
    status: "queued", parent_id: null, prompt, ref_id: null, seed: null,
    input_refs: ["upload:up.wav"], artifact_refs: [], error: null,
    idempotency_key: null, created_at: t, updated_at: t,
  };
}

describe("local fx tools", () => {
  it("tuner + spectrum + gain run in-core with no sidecar", async () => {
    setup();
    unloadAll();
    for (const id of ["fx-tuner", "fx-spectrum", "fx-gain"]) {
      expect(loadTool(id).ok).toBe(true);
    }
    const q = createMemoryQueue();
    const s = createMemoryStore();

    s.createJob(fxJob("t", "fx-tuner", "tune it"));
    q.enqueue("batch", "t");
    expect(await processNext(q, s)).toBe(true);
    expect(s.getJob("t")?.status).toBe("done");
    const take = s.eventsAfter("t", 0).find((e) => e.type === "take");
    expect((take?.data as { pitch: { note: string } }).pitch.note).toBe("A4");

    s.createJob(fxJob("sp", "fx-spectrum", "analyze"));
    q.enqueue("batch", "sp");
    expect(await processNext(q, s)).toBe(true);
    expect(s.getJob("sp")?.status).toBe("done");

    s.createJob(fxJob("g", "fx-gain", '{"db": 6}'));
    q.enqueue("batch", "g");
    expect(await processNext(q, s)).toBe(true);
    expect(s.getJob("g")?.status).toBe("done");
    expect(s.getJob("g")?.artifact_refs[0]).toMatch(/\.wav$/);
  });

  it("gain rejects non-JSON prompt honestly", async () => {
    setup();
    unloadAll();
    expect(loadTool("fx-gain").ok).toBe(true);
    const q = createMemoryQueue();
    const s = createMemoryStore();
    s.createJob(fxJob("bad", "fx-gain", "louder please"));
    q.enqueue("batch", "bad");
    expect(await processNext(q, s)).toBe(true);
    expect(s.getJob("bad")?.status).toBe("error");
    expect(s.getJob("bad")?.error).toMatch(/JSON/);
  });
});
