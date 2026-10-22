// Shared domain types. No framework imports here.

export type JobStatus =
  | "queued"
  | "active"
  | "done"
  | "error"
  | "interrupted";

export type JobMode = "batch" | "stream";

export interface Job {
  id: string;
  owner_id: string;
  tool_id: string;
  mode: JobMode;
  status: JobStatus;
  parent_id: string | null;
  prompt: string | null;
  ref_id: string | null;
  seed: number | null;
  input_refs: string[];
  artifact_refs: string[];
  error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export type JobEventType =
  | "status"
  | "chunk"
  | "waveform"
  | "transcript"
  | "take"
  | "done";

export interface JobEvent {
  seq: number;
  job_id: string;
  type: JobEventType;
  data: unknown;
  created_at: string;
}

export interface ToolManifest {
  id: string;
  version: string;
  backend: "transformers" | "diffusers" | "audiocraft" | "onnx" | "api" | "local";
  device: "gpu" | "cpu";
  vram_gb: number;
  tier: "tiny" | "small" | "medium" | "full";
  description: string;
}

export interface GpuStatus {
  total_gb: number;
  cap_gb: number;
  used_gb: number;
  loaded: string[];
}
