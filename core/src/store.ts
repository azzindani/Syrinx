// Store behind an interface. v1 is memory plus event log so SSE
// replay works; SQLite plus fs implement the same surface later.
import type { Job, JobEvent } from "./types.js";

export interface Store {
  createJob(job: Job): void;
  getJob(id: string): Job | null;
  listJobs(): Job[];
  updateJob(id: string, patch: Partial<Job>): Job | null;
  appendEvent(jobId: string, type: JobEvent["type"], data: unknown): JobEvent;
  eventsAfter(jobId: string, afterSeq: number): JobEvent[];
}

export function createMemoryStore(): Store {
  const jobs = new Map<string, Job>();
  const events = new Map<string, JobEvent[]>();
  let seq = 0;
  const now = () => new Date().toISOString();
  return {
    createJob(job) {
      jobs.set(job.id, job);
      events.set(job.id, []);
    },
    getJob(id) {
      return jobs.get(id) ?? null;
    },
    listJobs() {
      return [...jobs.values()].sort((a, b) =>
        a.created_at < b.created_at ? 1 : -1,
      );
    },
    updateJob(id, patch) {
      const cur = jobs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updated_at: now() };
      jobs.set(id, next);
      return next;
    },
    appendEvent(jobId, type, data) {
      const ev: JobEvent = {
        seq: ++seq,
        job_id: jobId,
        type,
        data,
        created_at: now(),
      };
      events.get(jobId)?.push(ev);
      return ev;
    },
    eventsAfter(jobId, afterSeq) {
      return (events.get(jobId) ?? []).filter((e) => e.seq > afterSeq);
    },
  };
}
