// Payload-ready result JSON: one stable shape per job for automation.
// Assembled purely from the persisted event log (Optic result.ts pattern).
import type { Store } from "./store.js";
import type { Job } from "./types.js";

export interface TakeRef {
  ref: string;
  url: string;
}

export interface JobResult {
  job_id: string;
  tool_id: string;
  status: Job["status"];
  parent_id: string | null;
  children: string[];
  prompt: string | null;
  ref_id: string | null;
  seed: number | null;
  transcript: string | null;
  takes: TakeRef[];
  analysis: {
    pitch?: unknown;
    spectrum?: unknown;
    prompt_tags?: string[];
    unknown_markers?: string[];
    ref_used?: string | null;
  };
  events: number;
  error: string | null;
}

export function assembleResult(store: Store, job: Job): JobResult {
  const events = store.eventsAfter(job.id, 0);
  const takes: TakeRef[] = [];
  const seen = new Set<string>();
  const pushTake = (ref: unknown) => {
    if (typeof ref !== "string" || !ref || seen.has(ref)) return;
    seen.add(ref);
    takes.push({ ref, url: `/v1/audio/${ref}` });
  };
  let transcript: string | null = null;
  const analysis: JobResult["analysis"] = {};
  for (const ev of events) {
    const d = ev.data as Record<string, unknown>;
    if (ev.type === "transcript" && typeof d.text === "string") {
      transcript = transcript ? `${transcript}\n${d.text}` : d.text;
    }
    if ((ev.type === "waveform" || ev.type === "chunk") && typeof d.ref === "string") {
      pushTake(d.ref);
    }
    if (ev.type === "take" && d && typeof d === "object") {
      if (d.pitch !== undefined) analysis.pitch = d.pitch;
      if (d.spectrum !== undefined) analysis.spectrum = d.spectrum;
      if (Array.isArray(d.prompt_tags)) analysis.prompt_tags = d.prompt_tags as string[];
      if (Array.isArray(d.unknown_markers)) analysis.unknown_markers = d.unknown_markers as string[];
      if (typeof d.ref_used === "string") analysis.ref_used = d.ref_used;
    }
  }
  // Artifact refs are the source of truth for playable takes.
  for (const ref of job.artifact_refs) pushTake(ref);
  const children = store
    .listJobs()
    .filter((j) => j.parent_id === job.id)
    .map((j) => j.id);
  return {
    job_id: job.id,
    tool_id: job.tool_id,
    status: job.status,
    parent_id: job.parent_id,
    children,
    prompt: job.prompt,
    ref_id: job.ref_id,
    seed: job.seed,
    transcript,
    takes,
    analysis,
    events: events.length,
    error: job.error,
  };
}
