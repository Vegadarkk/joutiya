import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/auth/client";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { HIDDEN_CLOSE_MS, MessagingLive, parseLiveEvent, RELEASE_GRACE_MS, type EventSourceLike } from "@/lib/messaging/live";

// The browser's live messaging client (design phase-5 D2, lots/sse.md): one EventSource per tab,
// ready/resync relaying, the badge total, backoff after a refused opening, no reconnection after
// 401/403/revoked, the hidden-tab close and the release grace. Fake EventSource, document and timers.

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** 200 and the first event. */
  accept(type: "ready" | "resync" = "ready"): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    this.send({ type });
  }

  send(event: MessagingEvent | Record<string, unknown> | string): void {
    this.onmessage?.({ data: typeof event === "string" ? event : JSON.stringify(event) } as MessageEvent<string>);
  }

  /** Non-200 answer: the browser gives up (CLOSED). */
  refuse(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }

  /** Dropped connection: the browser reconnects by itself (CONNECTING). */
  drop(): void {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }
}

class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  set(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

interface Options {
  unread?: () => Promise<{ total: number }>;
  session?: () => Promise<unknown>;
  random?: number;
}

function setup(options: Options = {}) {
  const sources: FakeSource[] = [];
  const doc = new FakeDocument();
  const fetchUnread = vi.fn(options.unread ?? (async () => ({ total: 3 })));
  const refreshSession = vi.fn(options.session ?? (async () => ({ uid: "u1" })));
  const live = new MessagingLive({
    openStream: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    fetchUnread,
    refreshSession,
    document: doc,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    random: () => options.random ?? 0.5,
  });
  const last = (): FakeSource => {
    const source = sources.at(-1);
    if (!source) throw new Error("no stream opened");
    return source;
  };
  return { live, sources, doc, fetchUnread, refreshSession, last };
}

/** Lets the probe and session promises settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLiveEvent", () => {
  it("keeps the known event types only", () => {
    expect(parseLiveEvent(JSON.stringify({ type: "message", cid: "c", mid: "m", at: 1 }))).toEqual({ type: "message", cid: "c", mid: "m", at: 1 });
    expect(parseLiveEvent(JSON.stringify({ type: "unread", total: 2 }))).toEqual({ type: "unread", total: 2 });
    for (const data of [JSON.stringify({ type: "typing" }), JSON.stringify({ type: "toString" }), "{", "null", "42", JSON.stringify(["ready"]), 7, undefined]) {
      expect(parseLiveEvent(data), String(data)).toBeNull();
    }
  });
});

describe("MessagingLive", () => {
  it("opens one stream per tab for every subscriber and paints the badge from GET unread", async () => {
    const { live, sources, fetchUnread, last } = setup();
    const a = vi.fn();
    const b = vi.fn();
    live.subscribe("u1", a);
    live.subscribe("u1", b);
    expect(sources).toHaveLength(1);
    expect(last().url).toBe("/api/messages/stream");
    expect(live.getSnapshot().status).toBe("connecting");
    await settle();
    expect(fetchUnread).toHaveBeenCalledTimes(1);
    expect(live.getSnapshot().unread).toBe(3);
    last().accept();
    expect(live.getSnapshot().status).toBe("open");
    expect(a).toHaveBeenCalledWith({ type: "ready" });
    expect(b).toHaveBeenCalledWith({ type: "ready" });
  });

  it("relays the first opening as ready and every later one as resync, with a fresh badge", async () => {
    const { live, last, fetchUnread } = setup();
    const listener = vi.fn();
    live.subscribe("u1", listener);
    await settle();
    last().accept("ready");
    expect(fetchUnread).toHaveBeenCalledTimes(1);
    // Automatic reconnection of the browser (Last-Event-ID): connecting, then resync.
    last().drop();
    expect(live.getSnapshot().status).toBe("connecting");
    last().send({ type: "resync" });
    expect(listener).toHaveBeenLastCalledWith({ type: "resync" });
    expect(fetchUnread).toHaveBeenCalledTimes(2);
    // A reopening after a refusal gets `ready` from the server: still a resync for the pages.
    last().refuse();
    await vi.advanceTimersByTimeAsync(5_000);
    last().accept("ready");
    expect(listener).toHaveBeenLastCalledWith({ type: "resync" });
    expect(listener.mock.calls.filter(([event]) => (event as MessagingEvent).type === "ready")).toHaveLength(1);
  });

  it("passes the other events on, keeps the badge total and ignores malformed data", async () => {
    const { live, last } = setup();
    const listener = vi.fn();
    const watcher = vi.fn();
    live.watch(watcher);
    live.subscribe("u1", listener);
    await settle();
    last().accept();
    listener.mockClear();
    watcher.mockClear();
    last().send({ type: "unread", total: 7 });
    expect(live.getSnapshot().unread).toBe(7);
    expect(watcher).toHaveBeenCalled();
    for (const event of [
      { type: "message", cid: "c", mid: "m", at: 1 },
      { type: "message_updated", cid: "c", mid: "m", at: 2 },
      { type: "read", cid: "c", at: 3 },
      { type: "conversation", cid: "c", at: 4 },
    ] as MessagingEvent[]) {
      last().send(event);
    }
    last().send("not json");
    last().send({ type: "presence" });
    expect(listener.mock.calls.map(([event]) => (event as MessagingEvent).type)).toEqual(["unread", "message", "message_updated", "read", "conversation"]);
  });

  it("keeps notifying the other subscribers when one throws", async () => {
    const { live, last } = setup();
    const after = vi.fn();
    live.subscribe("u1", () => {
      throw new Error("boom");
    });
    live.subscribe("u1", after);
    await settle();
    last().accept();
    expect(after).toHaveBeenCalledWith({ type: "ready" });
  });

  it("reopens a refused stream after 5 s, 15 s, then every 60 s, and starts over once live", async () => {
    const { live, sources, last, fetchUnread } = setup();
    live.subscribe("u1", vi.fn());
    await settle();
    for (const delay of [5_000, 15_000, 60_000, 60_000]) {
      const count = sources.length;
      last().refuse();
      await settle();
      expect(live.getSnapshot().status).toBe("down");
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sources, `before ${delay}`).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources, `at ${delay}`).toHaveLength(count + 1);
      expect(sources[count - 1]?.closed).toBe(true);
    }
    // Each refusal was probed (and refreshed the badge).
    expect(fetchUnread).toHaveBeenCalledTimes(1 + 4);
    last().accept();
    const count = sources.length;
    last().refuse();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sources).toHaveLength(count + 1);
  });

  it("spreads the reopening delay by ±20%", async () => {
    for (const [random, delay] of [
      [0, 4_000],
      [1, 6_000],
    ] as const) {
      const { live, sources, last } = setup({ random });
      live.subscribe("u1", vi.fn());
      await settle();
      last().refuse();
      await settle();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sources).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(2);
    }
  });

  it("never reopens after a 401: it asks /api/auth/me and routes when the session is gone", async () => {
    const { live, sources, last, refreshSession } = setup({
      unread: async () => Promise.reject(new ApiError(401, "unauthenticated")),
      session: async () => null,
    });
    const signedOut = vi.fn();
    live.onSignedOut(signedOut);
    live.subscribe("u1", vi.fn());
    await settle();
    last().refuse();
    await settle();
    expect(live.getSnapshot().status).toBe("stopped");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(signedOut).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sources).toHaveLength(1);
  });

  it("does not route after a 401 when /api/auth/me still answers a session, and stays closed", async () => {
    const { live, sources, last } = setup({ unread: async () => Promise.reject(new ApiError(401, "unauthenticated")) });
    const signedOut = vi.fn();
    live.onSignedOut(signedOut);
    live.subscribe("u1", vi.fn());
    await settle();
    last().refuse();
    await settle();
    expect(signedOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sources).toHaveLength(1);
    expect(live.getSnapshot().status).toBe("stopped");
  });

  it("stops for good on a 403 (staff account), without asking for the session", async () => {
    const { live, sources, last, refreshSession } = setup({ unread: async () => Promise.reject(new ApiError(403, "forbidden")) });
    live.subscribe("u1", vi.fn());
    await settle();
    last().refuse();
    await settle();
    expect(live.getSnapshot().status).toBe("stopped");
    expect(refreshSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sources).toHaveLength(1);
  });

  it("backs off on any other refusal (429, 503, network)", async () => {
    for (const error of [new ApiError(429, "rate_limited"), new ApiError(503, "unavailable"), new TypeError("fetch failed")]) {
      const { live, sources, last } = setup({ unread: async () => Promise.reject(error) });
      live.subscribe("u1", vi.fn());
      await settle();
      last().refuse();
      await settle();
      expect(live.getSnapshot().status).toBe("down");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sources).toHaveLength(2);
    }
  });

  it("closes on revoked, never reopens, and routes once /api/auth/me has no session", async () => {
    const { live, sources, last, refreshSession, doc } = setup({ session: async () => null });
    const listener = vi.fn();
    const signedOut = vi.fn();
    live.onSignedOut(signedOut);
    live.subscribe("u1", listener);
    await settle();
    last().accept();
    last().send({ type: "revoked" });
    expect(last().closed).toBe(true);
    expect(live.getSnapshot().status).toBe("stopped");
    expect(listener).toHaveBeenLastCalledWith({ type: "revoked" });
    await settle();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(signedOut).toHaveBeenCalledTimes(1);
    // Hidden then visible again: still closed.
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sources).toHaveLength(1);
  });

  it("closes 60 s after the tab is hidden and reopens when it is visible again", async () => {
    const { live, sources, last, doc } = setup();
    const listener = vi.fn();
    live.subscribe("u1", listener);
    await settle();
    last().accept();
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1);
    expect(last().closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().closed).toBe(true);
    expect(live.getSnapshot().status).toBe("paused");
    doc.set("visible");
    expect(sources).toHaveLength(2);
    expect(live.getSnapshot().status).toBe("connecting");
    last().accept("ready");
    expect(listener).toHaveBeenLastCalledWith({ type: "resync" });
  });

  it("keeps the stream when the tab comes back within 60 s", async () => {
    const { live, sources, last, doc } = setup();
    live.subscribe("u1", vi.fn());
    await settle();
    last().accept();
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(sources).toHaveLength(1);
    expect(last().closed).toBe(false);
    expect(live.getSnapshot().status).toBe("open");
  });

  it("does not reopen a refused stream in a long-hidden tab until it is visible", async () => {
    const { live, sources, last, doc } = setup();
    live.subscribe("u1", vi.fn());
    await settle();
    doc.set("hidden");
    last().refuse();
    await settle();
    // The hidden close comes first (60 s): the backoff timer goes with it.
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(live.getSnapshot().status).toBe("paused");
    const count = sources.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sources).toHaveLength(count);
    doc.set("visible");
    expect(sources).toHaveLength(count + 1);
  });

  it("arms the hidden close when the first subscriber mounts in a hidden tab", async () => {
    const { live, last, doc } = setup();
    doc.visibilityState = "hidden";
    live.subscribe("u1", vi.fn());
    await settle();
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(last().closed).toBe(true);
    expect(live.getSnapshot().status).toBe("paused");
  });

  it("outlives its last subscriber by a second (route changes) and then closes", async () => {
    const { live, sources, last, doc } = setup();
    const leave = live.subscribe("u1", vi.fn());
    await settle();
    last().accept();
    leave();
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS - 1);
    // The next page subscribes in time: same stream.
    const leaveAgain = live.subscribe("u1", vi.fn());
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
    expect(sources).toHaveLength(1);
    expect(last().closed).toBe(false);
    leaveAgain();
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
    expect(last().closed).toBe(true);
    expect(live.getSnapshot().status).toBe("idle");
    expect(doc.listeners.size).toBe(0);
    // A later subscription opens a new stream.
    live.subscribe("u1", vi.fn());
    expect(sources).toHaveLength(2);
  });

  it("drops a probe answer that arrives after the stream was released", async () => {
    let answer: (value: { total: number }) => void = () => undefined;
    const { live, sources, last } = setup({ unread: () => new Promise((resolve) => (answer = resolve)) });
    const leave = live.subscribe("u1", vi.fn());
    last().refuse();
    leave();
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
    answer({ total: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sources).toHaveLength(1);
    expect(live.getSnapshot().status).toBe("idle");
  });

  it("starts over for another account (sign-out and sign-in without a reload)", async () => {
    const { live, sources, fetchUnread } = setup();
    const first = vi.fn();
    live.subscribe("u1", first);
    await settle();
    sources[0]?.accept();
    const second = vi.fn();
    live.subscribe("u2", second);
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(2);
    await settle();
    expect(fetchUnread).toHaveBeenCalledTimes(2);
    sources[1]?.accept();
    expect(second).toHaveBeenCalledWith({ type: "ready" });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("ignores the events of a stream it already closed", async () => {
    const { live, sources, doc } = setup();
    const listener = vi.fn();
    live.subscribe("u1", listener);
    await settle();
    const old = sources[0];
    old?.accept();
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    listener.mockClear();
    old?.send({ type: "message", cid: "c", mid: "m", at: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
