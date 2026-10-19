import "server-only";
import { randomBytes } from "node:crypto";
import { requireUser } from "@/lib/auth/guards";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { HttpError, unavailable } from "@/lib/http/errors";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { BusUnavailableError, StreamLimitError, messagingBus, type MessagingBus, type StreamSink } from "./bus";
import { markSeen } from "./unread";

// GET /api/messages/stream (design D2, D9): the account's live messaging events as server-sent
// events. Session cookie with the revocation check, suspended accounts included (they still read);
// one subscription per account and process (bus.ts). Frames: `retry:` first, then one event with an
// id (`ready`, or `resync` when the browser reconnects with Last-Event-ID), then every event of the
// account as `id:` + `data: <JSON>` (no event name), and a comment every 25 s for Cloudflare's 100 s
// proxy timeout. The stream ends after about 30 minutes: the browser reconnects, re-authenticated.

export const HEARTBEAT_MS = 25_000;
export const STREAM_LIFETIME_MS = 30 * 60 * 1000;
/** Lifetimes and reconnection delays are spread: a restart must not bring every browser back at once. */
const LIFETIME_JITTER_MS = 60_000;
const RETRY_MIN_MS = 2_000;
const RETRY_SPREAD_MS = 4_000;

export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

export interface StreamOptions {
  /** The browser reconnected with Last-Event-ID: the first event is `resync`. */
  resync: boolean;
  /** Aborted when the client goes away. */
  signal?: AbortSignal;
  heartbeatMs?: number;
  lifetimeMs?: number;
  retryMs?: number;
}

const spread = (base: number, range: number) => base + Math.floor(Math.random() * range);

/**
 * The event stream of `uid`, registered on `bus` before the response is returned: a full bus
 * answers 503 (429 for an account over its own cap), an unreachable Valkey 503.
 */
export async function openEventStream(bus: MessagingBus, uid: string, options: StreamOptions): Promise<Response> {
  const encoder = new TextEncoder();
  const streamId = randomBytes(6).toString("base64url");
  let seq = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const finish = (closeBody: boolean) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    options.signal?.removeEventListener("abort", onAbort);
    bus.release(uid, sink);
    if (closeBody) {
      try {
        controller?.close();
      } catch {
        // Already closed or errored by the runtime.
      }
    }
  };
  const onAbort = () => finish(true);
  const write = (text: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      finish(false);
    }
  };
  const frame = (event: MessagingEvent) => `id: ${streamId}.${(seq += 1).toString(36)}\ndata: ${JSON.stringify(event)}\n\n`;
  const sink: StreamSink = { send: (event) => write(frame(event)), close: () => finish(true) };

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      finish(false);
    },
  });
  // Queued before the subscription: the browser reads them once the response is out, by then live.
  write(`retry: ${options.retryMs ?? spread(RETRY_MIN_MS, RETRY_SPREAD_MS)}\n\n`);
  sink.send(options.resync ? { type: "resync" } : { type: "ready" });

  try {
    await bus.open(uid, sink);
  } catch (error) {
    finish(true);
    if (error instanceof StreamLimitError) {
      throw error.scope === "uid" ? new HttpError(429, "rate_limited", "too many open streams", { headers: { "Retry-After": "30" } }) : unavailable("too many open streams");
    }
    if (error instanceof BusUnavailableError) throw unavailable("live messaging unavailable");
    throw error;
  }
  if (options.signal?.aborted) {
    finish(true);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    heartbeat = setInterval(() => write(": hb\n\n"), options.heartbeatMs ?? HEARTBEAT_MS);
    lifetime = setTimeout(() => finish(true), options.lifetimeMs ?? spread(STREAM_LIFETIME_MS, LIFETIME_JITTER_MS));
  }
  return new Response(body, { status: 200, headers: STREAM_HEADERS });
}

/** GET /api/messages/stream -> text/event-stream (503 without Valkey: the client retries later). */
export async function handleStream(request: Request): Promise<Response> {
  const auth = await requireUser(request, { checkRevoked: true, allowSuspended: true });
  await enforceLimit("messages.stream.uid", auth.user.uid);
  const bus = messagingBus();
  if (!bus) throw unavailable("live messaging unavailable");
  const lastEventId = request.headers.get("last-event-id")?.trim() ?? "";
  const response = await openEventStream(bus, auth.user.uid, { resync: lastEventId.length > 0, signal: request.signal });
  await markSeen(auth.user.uid);
  return response;
}
