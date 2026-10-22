import { describe, expect, it } from "vitest";
import { createMemoryQueue } from "./queue.js";

describe("queue", () => {
  it("stream preempts batch", () => {
    const q = createMemoryQueue();
    q.enqueue("batch", "b1");
    q.enqueue("stream", "s1");
    expect(q.dequeue()?.jobId).toBe("s1");
    expect(q.dequeue()?.jobId).toBe("b1");
  });
});
