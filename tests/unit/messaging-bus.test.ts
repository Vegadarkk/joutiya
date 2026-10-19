import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { BusUnavailableError, MAX_STREAMS, MAX_STREAMS_PER_UID, MessagingBus, StreamLimitError, parseEvent, type StreamSink } from "@/lib/messaging/bus";
import { eventChannel, publishEvents, publishNewMessage, publishRead, publishRevoked, setEventPublisherForTests } from "@/lib/messaging/events";
import { FakePubSub } from "./messaging-fake-pubsub";

// The per-process event bus of the live messaging stream (design D2): one SUBSCRIBE per account
// whatever its number of streams (refcounted, kept in order), fan-out to every stream of the
// account and only to it, `revoked` closes them, caps per account and per process, a lost
// connection closes everything; the publishers never fail a write.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

class Sink implements StreamSink {
  readonly events: MessagingEvent[] = [];
  closed = 0;
  constructor(private readonly onClose?: () => void) {}
  send(event: MessagingEvent): void {
    this.events.push(event);
  }
  close(): void {
    this.closed += 1;
    this.onClose?.();
  }
}

const AT = 1_760_000_000_000;
const message = (cid: string, mid = "m".repeat(20)): MessagingEvent => ({ type: "message", cid, mid, at: AT });

let pubsub: FakePubSub;
let bus: MessagingBus;

beforeEach(() => {
  pubsub = new FakePubSub();
  bus = new MessagingBus(pubsub);
  setEventPublisherForTests(pubsub.publish);
});

afterEach(() => setEventPublisherForTests(undefined));

/** A sink that releases itself on close, as the stream does. */
function selfReleasing(uid: string): Sink {
  const sink: Sink = new Sink(() => bus.release(uid, sink));
  return sink;
}

describe("subscriptions", () => {
  it("subscribes an account once for all its streams and unsubscribes with the last one", async () => {
    const [a, b] = [new Sink(), new Sink()];
    await bus.open("u1", a);
    await bus.open("u1", b);
    expect(pubsub.commands).toEqual([`subscribe ${eventChannel("u1")}`]);
    expect(bus.stats()).toEqual({ streams: 2, accounts: 1 });

    bus.release("u1", a);
    bus.release("u1", a);
    await Promise.resolve();
    expect(pubsub.channels.has(eventChannel("u1"))).toBe(true);
    bus.release("u1", b);
    await vi.waitFor(() => expect(pubsub.channels.size).toBe(0));
    expect(pubsub.commands).toEqual([`subscribe ${eventChannel("u1")}`, `unsubscribe ${eventChannel("u1")}`]);
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
  });

  it("keeps SUBSCRIBE and UNSUBSCRIBE of an account in order when a stream comes back at once", async () => {
    const first = new Sink();
    await bus.open("u1", first);
    bus.release("u1", first);
    const again = new Sink();
    await bus.open("u1", again);
    await vi.waitFor(() => expect(pubsub.commands).toHaveLength(3));
    expect(pubsub.commands.map((command) => command.split(" ")[0])).toEqual(["subscribe", "unsubscribe", "subscribe"]);
    expect(pubsub.channels.has(eventChannel("u1"))).toBe(true);
    await pubsub.publish([{ uid: "u1", event: message("c1") }]);
    expect(again.events).toEqual([message("c1")]);
  });

  it("refuses an open when the subscription fails, and registers nothing", async () => {
    pubsub.failing = true;
    const sink = new Sink();
    await expect(bus.open("u1", sink)).rejects.toBeInstanceOf(BusUnavailableError);
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
    pubsub.failing = false;
    await bus.open("u1", sink);
    expect(pubsub.channels.has(eventChannel("u1"))).toBe(true);
  });

  it("waits for the first connection, and gives up after its timeout", async () => {
    vi.useFakeTimers();
    try {
      pubsub.status = "connecting";
      const slow = new MessagingBus(pubsub, { perUid: 5, total: 10, readyTimeoutMs: 1000 });
      const waiting = slow.open("u1", new Sink());
      pubsub.status = "ready";
      pubsub.emit("ready");
      await waiting;
      expect(pubsub.channels.has(eventChannel("u1"))).toBe(true);

      pubsub.status = "reconnecting";
      const refused = expect(slow.open("u2", new Sink())).rejects.toBeInstanceOf(BusUnavailableError);
      await vi.advanceTimersByTimeAsync(1000);
      await refused;
      expect(slow.stats()).toEqual({ streams: 1, accounts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fan-out", () => {
  it("delivers an account's events to all its streams and to no other account", async () => {
    const [a, b, other] = [new Sink(), new Sink(), new Sink()];
    await bus.open("u1", a);
    await bus.open("u1", b);
    await bus.open("u2", other);
    await publishNewMessage({ cid: "c1", mid: "m".repeat(20), senderUid: "u2", recipientUid: "u1", recipientUnread: 3, at: new Date(AT) });
    expect(a.events).toEqual([message("c1"), { type: "unread", total: 3 }]);
    expect(b.events).toEqual(a.events);
    expect(other.events).toEqual([message("c1")]);
  });

  it("relays only well-formed events, with their known fields", async () => {
    const sink = new Sink();
    await bus.open("u1", sink);
    const channel = eventChannel("u1");
    pubsub.push(channel, "not json");
    pubsub.push(channel, JSON.stringify({ type: "resync" }));
    pubsub.push(channel, JSON.stringify({ type: "message", cid: "c/1", mid: "m1", at: AT }));
    pubsub.push(channel, JSON.stringify({ type: "unread", total: -1 }));
    pubsub.push(channel, JSON.stringify({ type: "read", cid: "c1", at: AT, text: "secret" }));
    pubsub.push("other:channel", JSON.stringify({ type: "revoked" }));
    expect(sink.events).toEqual([{ type: "read", cid: "c1", at: AT }]);
    expect(sink.closed).toBe(0);
    expect(parseEvent(JSON.stringify({ type: "conversation", cid: "c1", at: AT }))).toEqual({ type: "conversation", cid: "c1", at: AT });
  });

  it("closes every stream of a revoked account after telling it, and only that account's", async () => {
    const [a, b, other] = [selfReleasing("u1"), selfReleasing("u1"), selfReleasing("u2")];
    await bus.open("u1", a);
    await bus.open("u1", b);
    await bus.open("u2", other);
    await publishRevoked("u1");
    for (const sink of [a, b]) {
      expect(sink.events).toEqual([{ type: "revoked" }]);
      expect(sink.closed).toBe(1);
    }
    expect(other.closed).toBe(0);
    expect(bus.stats()).toEqual({ streams: 1, accounts: 1 });
    await vi.waitFor(() => expect([...pubsub.channels]).toEqual([eventChannel("u2")]));
  });
});

describe("caps and connection loss", () => {
  it("caps the streams of one account and of the process", async () => {
    for (let index = 0; index < MAX_STREAMS_PER_UID; index += 1) await bus.open("u1", new Sink());
    await expect(bus.open("u1", new Sink())).rejects.toMatchObject({ scope: "uid" });
    await bus.open("u2", new Sink());

    const small = new MessagingBus(pubsub, { perUid: 2, total: 3, readyTimeoutMs: 10 });
    const sinks = [new Sink(), new Sink(), new Sink()];
    await small.open("a", sinks[0]!);
    await small.open("b", sinks[1]!);
    await small.open("c", sinks[2]!);
    const full = small.open("d", new Sink());
    await expect(full).rejects.toBeInstanceOf(StreamLimitError);
    await expect(small.open("d", new Sink())).rejects.toMatchObject({ scope: "process" });
    small.release("a", sinks[0]!);
    await small.open("d", new Sink());
    expect(MAX_STREAMS).toBeGreaterThanOrEqual(MAX_STREAMS_PER_UID);
  });

  it("closes every stream when the connection is lost; nothing stays registered", async () => {
    const sinks = [selfReleasing("u1"), selfReleasing("u1"), selfReleasing("u2")];
    await bus.open("u1", sinks[0]!);
    await bus.open("u1", sinks[1]!);
    await bus.open("u2", sinks[2]!);
    pubsub.emit("close");
    expect(sinks.map((sink) => sink.closed)).toEqual([1, 1, 1]);
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
    // The server dropped the subscriptions with the connection: nothing to unsubscribe.
    expect(pubsub.commands.filter((command) => command.startsWith("unsubscribe"))).toEqual([]);
  });
});

describe("publishers", () => {
  it("send the read receipt to the other side and the row and badge to the reader", async () => {
    await publishRead({ cid: "c1", readerUid: "u1", otherUid: "u2", readerUnread: null, at: new Date(AT) });
    expect(pubsub.eventsFor("u2")).toEqual([{ type: "read", cid: "c1", at: AT }]);
    expect(pubsub.eventsFor("u1")).toEqual([{ type: "conversation", cid: "c1", at: AT }]);
    await publishRead({ cid: "c1", readerUid: "u1", otherUid: "u2", readerUnread: 0, at: new Date(AT) });
    expect(pubsub.eventsFor("u1").at(-1)).toEqual({ type: "unread", total: 0 });
  });

  it("never throw: a failing or missing Valkey is logged and skipped", async () => {
    pubsub.failing = true;
    await expect(publishRevoked("u1")).resolves.toBeUndefined();
    setEventPublisherForTests(null);
    await expect(publishEvents([{ uid: "u1", event: { type: "revoked" } }])).resolves.toBeUndefined();
    expect(pubsub.published).toEqual([]);
  });
});
