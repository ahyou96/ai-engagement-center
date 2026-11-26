import { EventEmitter } from "node:events";
import { db, J } from "./db";
import { nowIso, ORG_ID } from "./util";

/**
 * Durable event stream. Every event is persisted with a monotonically increasing `seq`
 * (used as the SSE event id) and then fanned out in-process. Clients reconnect with
 * Last-Event-ID and replay anything they missed from the table — ordered and de-duplicated by seq.
 */
const g = globalThis as unknown as { __aecBus?: EventEmitter };
export const bus = g.__aecBus ?? (g.__aecBus = new EventEmitter().setMaxListeners(500));

export type StreamEvent = { seq: number; topic: string; ref_id: string | null; type: string; payload: unknown; at: string };

export function publish(topic: string, type: string, payload: unknown, refId: string | null = null): StreamEvent {
  const at = nowIso();
  const info = db().prepare("INSERT INTO stream_events (topic, ref_id, type, payload, at) VALUES (?,?,?,?,?)").run(topic, refId, type, J.str(payload), at);
  const ev: StreamEvent = { seq: Number(info.lastInsertRowid), topic, ref_id: refId, type, payload, at };
  bus.emit("event", ev);
  return ev;
}

export function replay(afterSeq: number, topics: string[] | null, refId?: string | null, limit = 2000): StreamEvent[] {
  const where: string[] = ["seq > ?"]; const params: unknown[] = [afterSeq];
  if (topics?.length) { where.push(`topic IN (${topics.map(() => "?").join(",")})`); params.push(...topics); }
  if (refId) { where.push("ref_id = ?"); params.push(refId); }
  return (db().prepare(`SELECT * FROM stream_events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${limit}`).all(...params) as Array<Record<string, unknown>>)
    .map((r) => ({ ...(r as unknown as StreamEvent), payload: J.parse(r.payload, null) }));
}

export function notify(kind: string, title: string, body: string, link?: string, severity: "info" | "warning" | "critical" | "success" = "info") {
  db().prepare("INSERT INTO notifications (org_id, kind, title, body, link, severity, at) VALUES (?,?,?,?,?,?,?)").run(ORG_ID, kind, title, body, link ?? null, severity, nowIso());
  publish("notifications", "notification", { kind, title, body, link, severity });
}

/** Build an SSE Response that replays from Last-Event-ID, then follows live events. */
export function sseResponse(req: Request, opts: { topics?: string[]; refId?: string; terminal?: (e: StreamEvent) => boolean }) {
  const url = new URL(req.url);
  // Reconnects resume from Last-Event-ID. Fresh topic subscriptions start live; per-entity streams (refId) replay their full history.
  const explicit = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  const last = explicit != null ? Number(explicit) || 0 : opts.refId ? 0 : (db().prepare("SELECT COALESCE(MAX(seq),0) m FROM stream_events").get() as { m: number }).m;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let lastSeq = last; let closed = false;
      const send = (e: StreamEvent) => {
        if (closed || e.seq <= lastSeq) return; // ordered + duplicate-safe
        if (opts.topics && !opts.topics.includes(e.topic)) return;
        if (opts.refId && e.ref_id !== opts.refId) return;
        lastSeq = e.seq;
        controller.enqueue(encoder.encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        if (opts.terminal?.(e)) close();
      };
      const close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch { /* already closed */ } };
      const listener = (e: StreamEvent) => send(e);
      bus.on("event", listener);
      const ping = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`)); }, 15000);
      cleanup = () => { bus.off("event", listener); clearInterval(ping); };
      controller.enqueue(encoder.encode(`retry: 2000\n\n`));
      for (const e of replay(last, opts.topics ?? null, opts.refId)) send(e);
      req.signal.addEventListener("abort", close);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
