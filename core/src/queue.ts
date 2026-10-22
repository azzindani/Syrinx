// Queue behind an interface. v1 is in-process; Redis/NATS later
// implement the same surface without touching routes.

export interface QueueStats {
  batch: number;
  stream: number;
}

export interface Queue {
  enqueue(queue: "batch" | "stream", jobId: string): void;
  dequeue(): { queue: "batch" | "stream"; jobId: string } | null;
  stats(): QueueStats;
}

export function createMemoryQueue(): Queue {
  const batch: string[] = [];
  const stream: string[] = [];
  return {
    enqueue(queue, jobId) {
      // Stream preempts batch at dequeue time; both stay queued here.
      (queue === "stream" ? stream : batch).push(jobId);
    },
    dequeue() {
      const nextStream = stream.shift();
      if (nextStream) return { queue: "stream", jobId: nextStream };
      const nextBatch = batch.shift();
      if (nextBatch) return { queue: "batch", jobId: nextBatch };
      return null;
    },
    stats() {
      return { batch: batch.length, stream: stream.length };
    },
  };
}
