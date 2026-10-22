import { describe, expect, it } from "vitest";
import { clearGpuWaitCache, gpuFree } from "./gpuwait.js";

const runner = (stdout: string) => async () => ({ stdout });
const failing = async () => {
  throw new Error("spawn nvidia-smi ENOENT");
};

describe("gpuwait", () => {
  it("parses used MiB and allows under cap", async () => {
    clearGpuWaitCache();
    const g = await gpuFree(5, runner("3161\n"));
    expect(g.free).toBe(false); // 3161 + 5120 > 7168
    expect(g.usedMiB).toBe(3161);
  });

  it("frees small tools alongside a busy GPU", async () => {
    clearGpuWaitCache();
    const g = await gpuFree(2, runner("3161\n"));
    expect(g.free).toBe(true); // 3161 + 2048 <= 7168
  });

  it("treats missing nvidia-smi as free (CPU/stub boxes)", async () => {
    clearGpuWaitCache();
    const g = await gpuFree(5, failing);
    expect(g.free).toBe(true);
    expect(g.reason).toBe("no-smi");
  });
});
