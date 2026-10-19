import "server-only";
import { Redis } from "ioredis";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { clientOptions } from "@/lib/valkey/clients";
import { EVENT_CHANNEL_PREFIX, eventChannel } from "./events";

// Per-process fan-out of the live messaging events (design D2): one dedicated subscriber connection
// to valkey-queue per web process, one SUBSCRIBE per account with at least one open stream here
// (refcounted, SUBSCRIBE and UNSUBSCRIBE of an account kept in order), each event delivered in
// memory to every stream of that account. A `revoked` event closes them at once. Losing the
// connection closes every stream: browsers reconnect (503 while Valkey is down) and resync.

/** Open streams of one account in this process (one per tab, D2). */
export const MAX_STREAMS_PER_UID = 5;
/** Open streams in this process (web container on the Always Free VM). */
export const MAX_STREAMS = 1000;
/** First connection: how long an open waits for the subscriber connection. */
const READY_TIMEOUT_MS = 1_500;

export interface StreamSink {
  /** Writes one event to the stream. */
  send(event: MessagingEvent): void;
  /** Ends the stream; the stream then releases itself from the bus. */
  close(): void;
}

/** What the bus needs of an ioredis connection (a fake in tests). */
export interface SubscriberConnection {
  readonly status: string;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "ready" | "close", listener: () => void): unknown;
}

export class StreamLimitError extends Error {
  constructor(readonly scope: "uid" | "process") {
    super(`too many open streams (${scope})`);
    this.name = "StreamLimitError";
  }
}

export class BusUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("messaging event bus unavailable", { cause });
    this.name = "BusUnavailableError";
  }
}

interface Entry {
  sinks: Set<StreamSink>;
  subscribed: Promise<void>;
}

const CID = /^[A-Za-z0-9_-]{1,64}$/;
const MID = /^[A-Za-z0-9]{1,64}$/;

/** The published event with its known fields only, or null (the stream never relays anything else). */
export function parseEvent(message: string): MessagingEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, cid, mid, at, total } = value as Record<string, unknown>;
  const hasCid = typeof cid === "string" && CID.test(cid);
  const hasAt = typeof at === "number" && Number.isFinite(at);
  switch (type) {
    case "message":
    case "message_updated":
      return hasCid && hasAt && typeof mid === "string" && MID.test(mid) ? { type, cid, mid, at } : null;
    case "read":
    case "conversation":
      return hasCid && hasAt ? { type, cid, at } : null;
    case "unread":
      return typeof total === "number" && Number.isInteger(total) && total >= 0 ? { type, total } : null;
    case "revoked":
      return { type };
    default:
      return null;
  }
}

export class MessagingBus {
  private readonly entries = new Map<string, Entry>();
  /** Last SUBSCRIBE or UNSUBSCRIBE of each account: the next one waits for it. */
  private readonly ops = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private streams = 0;

  constructor(
    private readonly connection: SubscriberConnection,
    private readonly limits: { perUid: number; total: number; readyTimeoutMs: number } = { perUid: MAX_STREAMS_PER_UID, total: MAX_STREAMS, readyTimeoutMs: READY_TIMEOUT_MS },
  ) {
    connection.on("message", (channel, message) => this.deliver(channel, message));
    connection.on("ready", () => {
      for (const resolve of [...this.waiters]) resolve();
      this.waiters.clear();
    });
    connection.on("close", () => this.closeAll());
  }

  /** Open streams and accounts subscribed in this process. */
  stats(): { streams: number; accounts: number } {
    return { streams: this.streams, accounts: this.entries.size };
  }

  /**
   * Registers a stream of `uid`, subscribing the account's channel on its first stream. Throws
   * StreamLimitError over a cap, BusUnavailableError when the subscription fails (nothing stays
   * registered then).
   */
  async open(uid: string, sink: StreamSink): Promise<void> {
    if (this.streams >= this.limits.total) throw new StreamLimitError("process");
    let entry = this.entries.get(uid);
    if (entry && entry.sinks.size >= this.limits.perUid) throw new StreamLimitError("uid");
    if (!entry) {
      entry = { sinks: new Set(), subscribed: this.serialize(uid, () => this.subscribe(uid)) };
      entry.subscribed.catch(() => undefined);
      this.entries.set(uid, entry);
    }
    entry.sinks.add(sink);
    this.streams += 1;
    try {
      await entry.subscribed;
    } catch (error) {
      this.release(uid, sink);
      throw new BusUnavailableError(error);
    }
  }

  /** Forgets a stream (idempotent); the account's channel is unsubscribed with its last stream. */
  release(uid: string, sink: StreamSink): void {
    const entry = this.entries.get(uid);
    if (!entry?.sinks.delete(sink)) return;
    this.streams -= 1;
    if (entry.sinks.size > 0) return;
    this.entries.delete(uid);
    this.serialize(uid, () => this.connection.unsubscribe(eventChannel(uid))).catch((error: unknown) => {
      logger.warn({ err: (error as Error).message }, "messaging bus: unsubscribe failed");
    });
  }

  /** Delivers a published message to the streams of its account; `revoked` then closes them. */
  deliver(channel: string, message: string): void {
    if (!channel.startsWith(EVENT_CHANNEL_PREFIX)) return;
    const entry = this.entries.get(channel.slice(EVENT_CHANNEL_PREFIX.length));
    if (!entry) return;
    const event = parseEvent(message);
    if (!event) {
      logger.warn("messaging bus: malformed event dropped");
      return;
    }
    const sinks = [...entry.sinks];
    for (const sink of sinks) quietly(() => sink.send(event));
    if (event.type === "revoked") for (const sink of sinks) quietly(() => sink.close());
  }

  /** The connection was lost: every stream ends (the server dropped the subscriptions with it). */
  closeAll(): void {
    if (this.streams > 0) logger.warn({ streams: this.streams }, "messaging bus: connection lost, closing the open streams");
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.ops.clear();
    this.streams = 0;
    for (const entry of entries) for (const sink of entry.sinks) quietly(() => sink.close());
  }

  private async subscribe(uid: string): Promise<void> {
    await this.ready();
    await this.connection.subscribe(eventChannel(uid));
  }

  private ready(): Promise<void> {
    if (this.connection.status === "ready") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new Error("subscriber connection not ready"));
      }, this.limits.readyTimeoutMs);
      this.waiters.add(done);
    });
  }

  /** Runs `op` after the previous operation of `uid` settled, so the server sees them in order. */
  private serialize(uid: string, op: () => Promise<unknown>): Promise<void> {
    const previous = this.ops.get(uid) ?? Promise.resolve();
    const next = previous.then(op, op).then(() => undefined);
    this.ops.set(uid, next);
    const forget = () => {
      if (this.ops.get(uid) === next) this.ops.delete(uid);
    };
    next.then(forget, forget);
    return next;
  }
}

function quietly(run: () => void): void {
  try {
    run();
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging bus: stream callback failed");
  }
}

const BUS_KEY = Symbol.for("joutiya.messaging.bus");
type GlobalBus = typeof globalThis & { [BUS_KEY]?: MessagingBus };

let busForTests: MessagingBus | null | undefined;

/** Tests: a bus on a fake connection (null = Valkey not configured); undefined restores the real one. */
export function setMessagingBusForTests(bus: MessagingBus | null | undefined): void {
  busForTests = bus;
}

function createValkeyBus(url: string): MessagingBus {
  // Subscriber mode: no offline queue (an open fails fast while Valkey is down), and no automatic
  // resubscription (the bus closed every stream on the loss; reopened streams subscribe again).
  const connection = new Redis(url, clientOptions("queue", { connectionName: "joutiya-queue-events", lazyConnect: false, enableOfflineQueue: false, autoResubscribe: false, maxRetriesPerRequest: 1 }));
  connection.on("error", (error: Error) => logger.warn({ err: error.message }, "messaging bus: valkey connection error"));
  return new MessagingBus(connection);
}

/**
 * This process's bus, created on first use; null when valkey-queue is not configured (dev). Kept on
 * globalThis: the standalone build evaluates modules once per server chunk (see firebase/admin.ts),
 * and a second bus would be a second subscriber connection with its own streams.
 */
export function messagingBus(): MessagingBus | null {
  if (busForTests !== undefined) return busForTests;
  const url = serverEnv().QUEUE_REDIS_URL;
  if (!url) return null;
  const cache = globalThis as GlobalBus;
  cache[BUS_KEY] ??= createValkeyBus(url);
  return cache[BUS_KEY];
}
