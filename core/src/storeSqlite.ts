// SQLite-backed Store. Same interface as memory; survives restarts.
// Crash resume: boot marks `active` jobs as `interrupted`.
// node:sqlite is loaded at runtime so the test runner does not rewrite it.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, JobEvent } from "./types.js";
import type { Store } from "./store.js";

export function createSqliteStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, owner_id TEXT, tool_id TEXT, mode TEXT,
      status TEXT, parent_id TEXT, prompt TEXT, ref_id TEXT, seed INTEGER,
      input_refs TEXT, artifact_refs TEXT, error TEXT,
      idempotency_key TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT,
      type TEXT, data TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, seq);
  `);
  // Forward-only migration for DBs created before parent_id existed.
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN parent_id TEXT`);
  } catch {
    // Column already present.
  }
  const now = () => new Date().toISOString();
  const rowToJob = (r: Record<string, unknown>): Job => ({
    id: r.id as string,
    owner_id: r.owner_id as string,
    tool_id: r.tool_id as string,
    mode: r.mode as Job["mode"],
    status: r.status as Job["status"],
    parent_id: (r.parent_id as string) ?? null,
    prompt: (r.prompt as string) ?? null,
    ref_id: (r.ref_id as string) ?? null,
    seed: (r.seed as number) ?? null,
    input_refs: JSON.parse((r.input_refs as string) || "[]"),
    artifact_refs: JSON.parse((r.artifact_refs as string) || "[]"),
    error: (r.error as string) ?? null,
    idempotency_key: (r.idempotency_key as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  });
  // Resume: anything left active at boot did not finish.
  db.prepare(`UPDATE jobs SET status='interrupted', updated_at=? WHERE status='active'`).run(now());
  return {
    createJob(job) {
      // Explicit columns: immune to ADD COLUMN position in migrated DBs.
      db.prepare(`INSERT INTO jobs
        (id, owner_id, tool_id, mode, status, parent_id, prompt, ref_id, seed,
         input_refs, artifact_refs, error, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        job.id, job.owner_id, job.tool_id, job.mode, job.status,
        job.parent_id, job.prompt, job.ref_id, job.seed,
        JSON.stringify(job.input_refs), JSON.stringify(job.artifact_refs),
        job.error, job.idempotency_key, job.created_at, job.updated_at,
      );
    },
    getJob(id) {
      const r = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      return r ? rowToJob(r) : null;
    },
    listJobs() {
      const rows = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`).all() as Record<string, unknown>[];
      return rows.map(rowToJob);
    },
    updateJob(id, patch) {
      const cur = this.getJob(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updated_at: now() };
      db.prepare(`UPDATE jobs SET status=?, prompt=?, ref_id=?, seed=?, input_refs=?, artifact_refs=?, error=?, updated_at=? WHERE id=?`).run(
        next.status, next.prompt, next.ref_id, next.seed,
        JSON.stringify(next.input_refs), JSON.stringify(next.artifact_refs),
        next.error, next.updated_at, id,
      );
      return next;
    },
    appendEvent(jobId, type, data) {
      const created = now();
      const r = db.prepare(`INSERT INTO events (job_id, type, data, created_at) VALUES (?,?,?,?) RETURNING seq`).get(
        jobId, type, JSON.stringify(data), created,
      ) as { seq: number };
      return { seq: Number(r.seq), job_id: jobId, type, data, created_at: created };
    },
    eventsAfter(jobId, afterSeq) {
      const rows = db.prepare(`SELECT seq, job_id, type, data, created_at FROM events WHERE job_id=? AND seq>? ORDER BY seq`).all(jobId, afterSeq) as Array<{
        seq: number | bigint; job_id: string; type: JobEvent["type"]; data: string; created_at: string;
      }>;
      return rows.map((r) => ({
        seq: Number(r.seq), job_id: r.job_id, type: r.type,
        data: JSON.parse(r.data), created_at: r.created_at,
      }));
    },
  };
}
