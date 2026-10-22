import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./store.js";
import { assembleResult } from "./result.js";
import type { Job } from "./types.js";

function job(id: string, parent_id: string | null = null): Job {
  const t = new Date().toISOString();
  return {
    id, owner_id: "local", tool_id: "tts-fish-s1mini", mode: "stream",
    status: "done", parent_id, prompt: "hello (whispering)", ref_id: "alice", seed: 7,
    input_refs: [], artifact_refs: ["take-1.wav"], error: null,
    idempotency_key: null, created_at: t, updated_at: t,
  };
}

describe("result assembler", () => {
  it("assembles transcript, takes, analysis, children from events", () => {
    const s = createMemoryStore();
    s.createJob(job("p"));
    s.createJob(job("c1", "p"));
    s.createJob(job("c2", "p"));
    s.appendEvent("p", "transcript", { text: "hello" });
    s.appendEvent("p", "waveform", { ref: "take-1.wav" });
    s.appendEvent("p", "take", { ref_used: "alice" });
    s.appendEvent("p", "take", { prompt_tags: ["whispering"] });
    s.appendEvent("p", "done", { tool_id: "tts-fish-s1mini" });
    const r = assembleResult(s, s.getJob("p")!);
    expect(r.job_id).toBe("p");
    expect(r.transcript).toBe("hello");
    expect(r.takes).toEqual([{ ref: "take-1.wav", url: "/v1/audio/take-1.wav" }]);
    expect(r.analysis.ref_used).toBe("alice");
    expect(r.analysis.prompt_tags).toEqual(["whispering"]);
    expect(r.children.sort()).toEqual(["c1", "c2"]);
    expect(r.parent_id).toBeNull();
    expect(r.events).toBe(5);
  });

  it("dedupes takes across waveform events and artifact refs", () => {
    const s = createMemoryStore();
    s.createJob(job("d"));
    s.appendEvent("d", "waveform", { ref: "take-1.wav" });
    const r = assembleResult(s, s.getJob("d")!);
    expect(r.takes).toHaveLength(1);
  });
});
