import { beforeEach, describe, expect, it } from "vitest";
import { gpuStatus, loadTool, unloadAll, unloadTool } from "./gpu.js";

describe("gpu manager", () => {
  beforeEach(() => unloadAll());

  it("loads fish-s1mini within cap", () => {
    expect(loadTool("tts-fish-s1mini").ok).toBe(true);
    const s = gpuStatus();
    expect(s.loaded).toContain("tts-fish-s1mini");
    expect(s.used_gb).toBeCloseTo(5);
  });

  it("rejects over-cap second load", () => {
    expect(loadTool("tts-fish-s1mini").ok).toBe(true);
    const res = loadTool("tts-qwen3-0.6B");
    expect(res.ok).toBe(false);
  });

  it("rejects unknown tools", () => {
    expect(loadTool("nope").ok).toBe(false);
  });

  it("unload frees budget", () => {
    loadTool("tts-fish-s1mini");
    unloadTool("tts-fish-s1mini");
    expect(gpuStatus().used_gb).toBe(0);
    expect(loadTool("tts-qwen3-0.6B").ok).toBe(true);
  });
});
