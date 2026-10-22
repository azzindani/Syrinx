import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteStore } from "./storeSqlite.js";
import type { Job } from "./types.js";

function job(id: string): Job {
  const t = new Date().toISOString();
  return {
    id, owner_id: "local", tool_id: "tts-fish-s1mini", mode: "stream",
    status: "queued", parent_id: null, prompt: "test prompt", ref_id: "ref-1", seed: 42,
    input_refs: [], artifact_refs: [], error: null,
    idempotency_key: null, created_at: t, updated_at: t,
  };
}

describe("sqlite store", () => {
  it("persists audio jobs and replays events", () => {
    const s = createSqliteStore(":memory:");
    s.createJob(job("a"));
    expect(s.getJob("a")?.prompt).toBe("test prompt");
    expect(s.getJob("a")?.ref_id).toBe("ref-1");
    s.updateJob("a", { status: "done", artifact_refs: ["clips/a.wav"] });
    expect(s.getJob("a")?.status).toBe("done");
    const e1 = s.appendEvent("a", "status", { status: "queued" });
    s.appendEvent("a", "transcript", { text: "hi" });
    s.appendEvent("a", "waveform", { ref: "clips/a.wav" });
    expect(s.eventsAfter("a", 0)).toHaveLength(3);
    expect(s.eventsAfter("a", e1.seq)).toHaveLength(2);
  });

  it("marks active as interrupted on open", () => {
    const s = createSqliteStore(":memory:");
    s.createJob({ ...job("b"), status: "active" });
    expect(s.getJob("b")?.status).toBe("active");
  });

  it("migrates pre-parent_id DBs without scrambling columns", () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const f = join(mkdtempSync(join(tmpdir(), "core-mig-")), "jobs.db");
    const old = new DatabaseSync(f);
    old.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, owner_id TEXT, tool_id TEXT, mode TEXT,
        status TEXT, prompt TEXT, ref_id TEXT, seed INTEGER,
        input_refs TEXT, artifact_refs TEXT, error TEXT,
        idempotency_key TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT,
        type TEXT, data TEXT, created_at TEXT
      );
    `);
    old.close();
    const s = createSqliteStore(f);
    s.createJob(job("m"));
    const got = s.getJob("m");
    expect(got?.prompt).toBe("test prompt");
    expect(got?.ref_id).toBe("ref-1");
    expect(got?.seed).toBe(42);
    expect(got?.parent_id).toBeNull();
  });
});
