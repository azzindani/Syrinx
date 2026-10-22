// Minimal SSE helper: replays missed events via Last-Event-ID,
// then streams new ones until the job finishes or client drops.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./store.js";

export async function streamJobEvents(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  store: Store,
) {
  const { id } = req.params;
  const job = store.getJob(id);
  if (!job) {
    reply.code(404).send({ error: "unknown job" });
    return;
  }
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let lastId = Number(req.headers["last-event-id"] ?? 0);
  let alive = true;
  req.raw.on("close", () => {
    alive = false;
  });
  const send = (seq: number, type: string, data: unknown) => {
    reply.raw.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Replay backlog first so reconnects lose nothing.
  for (const ev of store.eventsAfter(id, lastId)) {
    send(ev.seq, ev.type, ev.data);
    lastId = ev.seq;
  }
  // Poll the store; the GPU worker appends events as it progresses.
  while (alive) {
    const fresh = store.eventsAfter(id, lastId);
    for (const ev of fresh) {
      send(ev.seq, ev.type, ev.data);
      lastId = ev.seq;
    }
    const cur = store.getJob(id);
    if (cur && (cur.status === "done" || cur.status === "error")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  reply.raw.end();
}
