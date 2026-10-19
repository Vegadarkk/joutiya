import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingBus } from "@/lib/messaging/bus";
import { eventChannel, publishNewMessage, publishRevoked, setEventPublisherForTests } from "@/lib/messaging/events";
import { HEARTBEAT_MS, STREAM_HEADERS, STREAM_LIFETIME_MS, openEventStream } from "@/lib/messaging/stream";
import { FakePubSub } from "./messaging-fake-pubsub";

// The server-sent event stream of the live messaging (design D2): headers, the first frames
// (retry, then ready or resync with an id), events as `id:` + `data:`, a heartbeat comment every
// 25 s, the end after the lifetime, on abort or on `revoked`, each releasing its bus slot.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const AT = 1_760_000_000_000;
const MID = "m".repeat(20);

let pubsub: FakePubSub;
let bus: MessagingBus;

beforeEach(() => {
  pubsub = new FakePubSub();
  bus = new MessagingBus(pubsub);
  setEventPublisherForTests(pubsub.publish);
});

afterEach(() => {
  setEventPublisherForTests(undefined);
  vi.useRealTimers();
});

/** Reads the body chunk by chunk; `text` is everything read so far. */
function reader(response: Response) {
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", done: false };
  return {
    state,
    /** Reads chunks until `text` contains `needle` (or the stream ends). */
    async until(needle: string): Promise<string> {
      while (!state.text.includes(needle) && !state.done) {
        const { value, done } = await stream.read();
        if (done) state.done = true;
        else state.text += decoder.decode(value);
      }
      return state.text;
    },
    async end(): Promise<string> {
      while (!state.done) {
        const { value, done } = await stream.read();
        if (done) state.done = true;
        else state.text += decoder.decode(value);
      }
      return state.text;
    },
  };
}

const dataLines = (text: string) => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as unknown);

describe("openEventStream", () => {
  it("answers event-stream headers, a retry delay and a ready event with an id, then the account's events", async () => {
    const response = await openEventStream(bus, "u1", { resync: false, retryMs: 3000 });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(STREAM_HEADERS)) expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const body = reader(response);
    const first = await body.until('"ready"');
    expect(first.startsWith("retry: 3000\n\n")).toBe(true);
    expect(first).toMatch(/\nid: [A-Za-z0-9_-]{8}\.1\ndata: \{"type":"ready"\}\n\n$/);

    await publishNewMessage({ cid: "c1", mid: MID, senderUid: "u2", recipientUid: "u1", recipientUnread: 2, at: new Date(AT) });
    const text = await body.until('"unread"');
    expect(dataLines(text)).toEqual([{ type: "ready" }, { type: "message", cid: "c1", mid: MID, at: AT }, { type: "unread", total: 2 }]);
    expect(text).toMatch(/id: [A-Za-z0-9_-]{8}\.3\ndata: \{"type":"unread"/);
    expect(text).not.toContain("Bonjour");
  });

  it("starts with resync when the browser reconnects with Last-Event-ID", async () => {
    const body = reader(await openEventStream(bus, "u1", { resync: true }));
    expect(dataLines(await body.until("data:"))).toEqual([{ type: "resync" }]);
  });

  it("writes a heartbeat comment every 25 s and ends after its lifetime, releasing its slot", async () => {
    vi.useFakeTimers();
    const response = await openEventStream(bus, "u1", { resync: false, lifetimeMs: STREAM_LIFETIME_MS });
    const body = reader(response);
    await body.until('"ready"');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(body.state.text).not.toContain(": hb");
    await vi.advanceTimersByTimeAsync(1);
    expect(await body.until(": hb\n\n")).toContain(": hb\n\n");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect((await body.until(": hb\n\n: hb")).match(/: hb\n\n/g)).toHaveLength(2);
    expect(bus.stats().streams).toBe(1);

    await vi.advanceTimersByTimeAsync(STREAM_LIFETIME_MS);
    await body.end();
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
    await vi.waitFor(() => expect(pubsub.channels.size).toBe(0));
  });

  it("spreads its lifetime around 30 minutes by default", async () => {
    vi.useFakeTimers();
    const body = reader(await openEventStream(bus, "u1", { resync: false }));
    await body.until('"ready"');
    await vi.advanceTimersByTimeAsync(STREAM_LIFETIME_MS - 1);
    expect(bus.stats().streams).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await body.end();
    expect(bus.stats().streams).toBe(0);
  });

  it("ends on revoked after relaying it", async () => {
    const body = reader(await openEventStream(bus, "u1", { resync: false }));
    await body.until('"ready"');
    await publishRevoked("u1");
    expect(dataLines(await body.end())).toEqual([{ type: "ready" }, { type: "revoked" }]);
    expect(bus.stats().streams).toBe(0);
  });

  it("releases its slot when the client goes away (abort or cancel)", async () => {
    const controller = new AbortController();
    const aborted = await openEventStream(bus, "u1", { resync: false, signal: controller.signal });
    const cancelled = await openEventStream(bus, "u1", { resync: false });
    expect(bus.stats()).toEqual({ streams: 2, accounts: 1 });
    controller.abort();
    await reader(aborted).end();
    expect(bus.stats().streams).toBe(1);
    await cancelled.body!.cancel();
    expect(bus.stats()).toEqual({ streams: 0, accounts: 0 });
    await vi.waitFor(() => expect(pubsub.channels.has(eventChannel("u1"))).toBe(false));
  });

  it("answers 429 over the account's cap, 503 over the process cap or without Valkey", async () => {
    const small = new MessagingBus(pubsub, { perUid: 1, total: 2, readyTimeoutMs: 10 });
    await openEventStream(small, "u1", { resync: false });
    await expect(openEventStream(small, "u1", { resync: false })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await openEventStream(small, "u2", { resync: false });
    await expect(openEventStream(small, "u3", { resync: false })).rejects.toMatchObject({ status: 503, code: "unavailable" });

    pubsub.failing = true;
    await expect(openEventStream(bus, "u4", { resync: false })).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(bus.stats().streams).toBe(0);
  });
});
