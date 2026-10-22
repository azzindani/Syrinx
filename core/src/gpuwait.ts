// Shared-GPU gate: the vision project and this core share one 8GB card
// with no common arbiter in v1. Before this core touches the GPU it asks
// nvidia-smi how much is already used (usually the vision side) and waits
// is already used (usually Optic) and waits if our model would breach
// the 7GB cap. Jobs stay queued meanwhile — queue-and-wait.
// Missing nvidia-smi (CPU/dev boxes, stubs) means no contention: free.
import { execFile } from "node:child_process";

const CAP_MIB = 7 * 1024;

export interface GpuWait {
  free: boolean;
  usedMiB: number;
  needMiB: number;
  reason: string;
}

type Runner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string }>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout: String(stdout) }),
    );
  });

// 2s cache: the worker polls every 500ms, don't fork constantly.
let cache: { at: number; usedMiB: number } | null = null;

export function clearGpuWaitCache(): void {
  cache = null;
}

async function usedMiB(run: Runner = defaultRunner): Promise<number | null> {
  const now = Date.now();
  if (cache && now - cache.at < 2000) return cache.usedMiB;
  let out: string;
  try {
    ({ stdout: out } = await run("nvidia-smi", [
      "--query-gpu=memory.used",
      "--format=csv,noheader,nounits",
    ]));
  } catch {
    return null; // no GPU tooling: nothing to contend with
  }
  const first = out.split("\n").map((l) => l.trim()).find(Boolean);
  const used = first ? Number(first) : NaN;
  if (!Number.isFinite(used)) return null;
  cache = { at: now, usedMiB: used };
  return used;
}

export async function gpuFree(
  needGb: number,
  run: Runner = defaultRunner,
): Promise<GpuWait> {
  const needMiB = Math.ceil(needGb * 1024);
  const used = await usedMiB(run);
  if (used === null) return { free: true, usedMiB: 0, needMiB, reason: "no-smi" };
  if (used + needMiB <= CAP_MIB) {
    return { free: true, usedMiB: used, needMiB, reason: "cap-ok" };
  }
  return {
    free: false,
    usedMiB: used,
    needMiB,
    reason: `gpu busy: ${used}MiB used + ${needMiB}MiB need > ${CAP_MIB}MiB cap. Waiting for other project.`,
  };
}
