// Typed gateway client. Same /v1 contract headless users get.
export interface ToolManifest {
  id: string; version: string; backend: string; device: string;
  vram_gb: number; tier: string; description: string;
}
export interface GpuStatus { total_gb: number; cap_gb: number; used_gb: number; loaded: string[] }
export interface Job {
  id: string; tool_id: string; mode: string; status: string;
  prompt: string | null; ref_id: string | null; parent_id: string | null;
  input_refs: string[]; artifact_refs: string[]; error: string | null;
}
export interface JobResult {
  job_id: string; tool_id: string; status: string;
  parent_id: string | null; children: string[];
  transcript: string | null;
  takes: Array<{ ref: string; url: string }>;
  analysis: Record<string, unknown>;
  events: number; error: string | null;
}

const j = async (r: Response) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? r.statusText);
  return r.json();
};

const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
};

export const api = {
  tools: (): Promise<ToolManifest[]> => fetch("/v1/tools").then(j),
  gpu: (): Promise<GpuStatus> => fetch("/v1/gpu").then(j),
  jobs: (): Promise<Job[]> => fetch("/v1/jobs").then(j),
  result: (id: string): Promise<JobResult> => fetch(`/v1/jobs/${id}/result`).then(j),
  retry: (id: string, body?: { seed?: number }): Promise<Job> =>
    fetch(`/v1/jobs/${id}/retry`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then(j),
  refs: (): Promise<{ refs: string[] }> => fetch("/v1/refs").then(j),
  loadTool: (id: string) => fetch(`/v1/tools/${id}/load`, { method: "POST" }).then(j),
  createJob: (body: { tool_id: string; mode?: string; prompt: string; ref_id?: string | null; input_refs?: string[] }): Promise<Job> =>
    fetch("/v1/jobs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j),
  upload: async (name: string, file: File): Promise<{ ref: string; seconds: number }> =>
    fetch("/v1/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, wav_b64: b64(await file.arrayBuffer()) }),
    }).then(j),
  uploadRef: async (ref_id: string, transcript: string, file: File): Promise<unknown> =>
    fetch("/v1/refs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref_id, transcript, wav_b64: b64(await file.arrayBuffer()) }),
    }).then(j),
};
