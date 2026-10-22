// Single-GPU exclusive lease manager. Only the selected tool
// is resident. v2 pools N GPUs behind the same surface.
import type { GpuStatus } from "./types.js";
import { registry } from "./tools.js";

const CAP_GB = 7;
const TOTAL_GB = 8;

const loaded = new Set<string>();
let leaseHolder: string | null = null;

export function gpuStatus(): GpuStatus {
  let used = 0;
  for (const id of loaded) {
    const m = registry.get(id);
    if (m && m.device === "gpu") used += m.vram_gb;
  }
  return { total_gb: TOTAL_GB, cap_gb: CAP_GB, used_gb: used, loaded: [...loaded] };
}

export function loadTool(id: string): { ok: boolean; error?: string } {
  const manifest = registry.get(id);
  if (!manifest) return { ok: false, error: `unknown tool ${id}` };
  // CPU tools and cloud providers use no VRAM, never block.
  if (manifest.device === "cpu" || manifest.backend === "api") {
    loaded.add(id);
    return { ok: true };
  }
  const { used_gb } = gpuStatus();
  if (!loaded.has(id) && used_gb + manifest.vram_gb > CAP_GB) {
    return {
      ok: false,
      error: `needs ${manifest.vram_gb}GB, only ${CAP_GB - used_gb}GB free. Unload ${[...loaded].join(", ") || "nothing"} first.`,
    };
  }
  loaded.add(id);
  return { ok: true };
}

export function unloadTool(id: string): void {
  loaded.delete(id);
  if (leaseHolder && !loaded.has(leaseHolder)) leaseHolder = null;
}

export function unloadAll(): void {
  loaded.clear();
  leaseHolder = null;
}
