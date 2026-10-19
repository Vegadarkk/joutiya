import { ApiError, refreshSession } from "@/lib/auth/client";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type { MessagingEvent, MessagingEventType } from "@/lib/contracts/messaging";
import { fetchUnread } from "./client";

// Live messaging in the browser (design phase-5 D2, lots/sse.md): one EventSource on
// GET /api/messages/stream per tab while a messaging page or the unread badge is mounted, shared by
// every subscriber of the tab, and the badge total it carries. Events are ids only: subscribers
// refetch through the API (client.ts).
// - The first event of each opening is relayed as `ready` the first time, `resync` afterwards (an
//   automatic reconnection or a reopening may have missed events).
// - A refused opening (non-200: 401, 403, 429, 503) closes the EventSource for good; it hides the
//   status, so GET /api/messages/unread probes it (and refreshes the badge): 401 and 403 stop for
//   good (401 also asks /api/auth/me), anything else reopens after 5 s, 15 s, then every 60 s (with
//   jitter). Meanwhile the status is `down` or `stopped`: an open thread polls (thread view).
// - `revoked` (ban or suspension): closed, never reopened; /api/auth/me then tells the pages
//   whether the session is gone (onSignedOut).
// - Closed 60 s after the tab is hidden, reopened when it is visible again; closed about a second
//   after the last subscriber leaves (a route change keeps the stream when the next page subscribes).
// The class is framework free (fake EventSource, timers and document in the unit tests).

/** idle: nobody listens; connecting: opening or reconnecting; open: live; down: refused, reopening later;
 *  paused: closed while the tab is hidden; stopped: revoked or refused for this account (no reconnection). */
export type LiveStatus = "idle" | "connecting" | "open" | "down" | "paused" | "stopped";

export interface LiveSnapshot {
  status: LiveStatus;
  /** Badge total; null until known. */
  unread: number | null;
}

export type LiveListener = (event: MessagingEvent) => void;

/** What the client needs of an EventSource. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface LiveDeps {
  openStream: (url: string) => EventSourceLike;
  fetchUnread: () => Promise<{ total: number }>;
  /** GET /api/auth/me again: the session, or null when signed out. */
  refreshSession: () => Promise<unknown>;
  document: VisibilityLike | null;
  setTimeout: (callback: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  random: () => number;
}

/** EventSource.CLOSED */
const CLOSED = 2;
/** Reopening delays after a refused opening; the last one repeats. */
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000] as const;
/** The stream closes after this long with the tab hidden (D2). */
export const HIDDEN_CLOSE_MS = 60_000;
/** The stream outlives its last subscriber this long (route changes). */
export const RELEASE_GRACE_MS = 1_000;
/** Every MessagingEventType (checked by the compiler; no value import of the zod contracts here). */
const EVENT_TYPES: Readonly<Record<MessagingEventType, true>> = { ready: true, resync: true, message: true, message_updated: true, read: true, conversation: true, unread: true, revoked: true };

/** The event of a `data:` line, or null for anything malformed. */
export function parseLiveEvent(data: unknown): MessagingEvent | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && Object.hasOwn(EVENT_TYPES, type) ? (value as MessagingEvent) : null;
  } catch {
    return null;
  }
}

export class MessagingLive {
  private readonly deps: LiveDeps;
  private readonly listeners = new Set<LiveListener>();
  private readonly watchers = new Set<() => void>();
  private readonly signedOutHandlers = new Set<() => void>();
  private snapshot: LiveSnapshot = { status: "idle", unread: null };
  private source: EventSourceLike | null = null;
  private account: string | null = null;
  /** Openings that reached their first event since start(). */
  private syncs = 0;
  /** Refused openings in a row (backoff step). */
  private attempt = 0;
  /** Bumped by every opening and stop: a late probe or session answer of an older one is dropped. */
  private generation = 0;
  private reconnectTimer: Timer | null = null;
  private hiddenTimer: Timer | null = null;
  private releaseTimer: Timer | null = null;
  private watchingVisibility = false;

  constructor(deps: LiveDeps) {
    this.deps = deps;
  }

  getSnapshot = (): LiveSnapshot => this.snapshot;

  /** Status and badge changes (useSyncExternalStore). */
  watch = (watcher: () => void): (() => void) => {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  };

  /** Called when the session turned out to be gone (revoked, 401): the page re-runs its guard. A new
   *  subscription for another account starts over (sign-in without a reload). */
  onSignedOut(handler: () => void): () => void {
    this.signedOutHandlers.add(handler);
    return () => {
      this.signedOutHandlers.delete(handler);
    };
  }

  /**
   * Listens to the stream of `account` (the session uid), opening it for the first subscriber. A
   * different account than the current one starts over (sign-out and sign-in without a reload).
   */
  subscribe(account: string, listener: LiveListener): () => void {
    if (this.account !== null && this.account !== account) this.reset();
    this.account = account;
    if (this.releaseTimer) {
      this.deps.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.listeners.add(listener);
    if (this.snapshot.status === "idle") this.start();
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0 || this.releaseTimer) return;
      this.releaseTimer = this.deps.setTimeout(() => {
        this.releaseTimer = null;
        if (this.listeners.size === 0) this.stop();
      }, RELEASE_GRACE_MS);
    };
  }

  /** GET /api/messages/unread now (after a read receipt while the stream is not live). */
  refreshUnread(): Promise<void> {
    return this.deps.fetchUnread().then(
      ({ total }) => this.setUnread(total),
      () => undefined,
    );
  }

  /** A total the page learned otherwise. */
  setUnread(total: number): void {
    if (Number.isInteger(total) && total >= 0 && total !== this.snapshot.unread) this.update({ unread: total });
  }

  private update(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const watcher of this.watchers) watcher();
  }

  private setStatus(status: LiveStatus): void {
    if (this.snapshot.status !== status) this.update({ status });
  }

  private emit(event: MessagingEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber's failure never stops the others.
      }
    }
  }

  private start(): void {
    this.syncs = 0;
    this.attempt = 0;
    const doc = this.deps.document;
    if (doc && !this.watchingVisibility) {
      doc.addEventListener("visibilitychange", this.onVisibility);
      this.watchingVisibility = true;
    }
    // First paint of the badge; `unread` events and resyncs keep it current.
    void this.refreshUnread();
    this.open();
    if (doc?.visibilityState === "hidden") this.armHiddenTimer();
  }

  private stop(): void {
    this.generation += 1;
    this.closeSource();
    this.clearTimers();
    if (this.watchingVisibility) {
      this.deps.document?.removeEventListener("visibilitychange", this.onVisibility);
      this.watchingVisibility = false;
    }
    this.setStatus("idle");
  }

  private reset(): void {
    this.stop();
    this.listeners.clear();
    this.update({ status: "idle", unread: null });
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.hiddenTimer, this.releaseTimer]) if (timer) this.deps.clearTimeout(timer);
    this.reconnectTimer = null;
    this.hiddenTimer = null;
    this.releaseTimer = null;
  }

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }

  private open(): void {
    if (this.reconnectTimer) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSource();
    this.generation += 1;
    this.setStatus("connecting");
    const source = this.deps.openStream(MESSAGING_API.stream);
    this.source = source;
    source.onopen = () => {
      if (this.source === source) this.setStatus("open");
    };
    source.onmessage = (message) => {
      if (this.source === source) this.receive(parseLiveEvent(message.data));
    };
    source.onerror = () => {
      if (this.source !== source) return;
      // CONNECTING: the browser reconnects by itself (Last-Event-ID, then `resync`).
      if (source.readyState === CLOSED) this.refused();
      else this.setStatus("connecting");
    };
  }

  private receive(event: MessagingEvent | null): void {
    if (!event) return;
    switch (event.type) {
      case "ready":
      case "resync": {
        this.attempt = 0;
        this.setStatus("open");
        const first = this.syncs === 0;
        this.syncs += 1;
        if (!first) void this.refreshUnread();
        this.emit({ type: first ? "ready" : "resync" });
        return;
      }
      case "unread":
        this.setUnread(event.total);
        this.emit(event);
        return;
      case "revoked":
        this.halt();
        this.emit(event);
        void this.checkSession();
        return;
      default:
        this.emit(event);
    }
  }

  /** The opening was refused (or the stream failed for good): probe why, then reopen later or stop. */
  private refused(): void {
    this.closeSource();
    this.setStatus("down");
    const generation = this.generation;
    this.deps.fetchUnread().then(
      ({ total }) => {
        this.setUnread(total);
        if (generation === this.generation) this.scheduleReconnect();
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 401 || status === 403) this.halt();
        else this.scheduleReconnect();
        if (status === 401) void this.checkSession();
      },
    );
  }

  /** No reopening for this account (revoked, 401, 403); the pages keep working without live updates. */
  private halt(): void {
    this.closeSource();
    for (const timer of [this.reconnectTimer, this.hiddenTimer]) if (timer) this.deps.clearTimeout(timer);
    this.reconnectTimer = null;
    this.hiddenTimer = null;
    this.setStatus("stopped");
  }

  /** After `revoked` or a 401: /api/auth/me refreshes the session; without one, the pages route. */
  private async checkSession(): Promise<void> {
    const generation = this.generation;
    let session: unknown = null;
    try {
      session = await this.deps.refreshSession();
    } catch {
      session = null;
    }
    if (generation !== this.generation || this.listeners.size === 0 || session) return;
    for (const handler of [...this.signedOutHandlers]) handler();
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 || this.snapshot.status === "stopped") return;
    const base = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
    this.attempt += 1;
    const delay = Math.round(base * (0.8 + 0.4 * this.deps.random()));
    if (this.reconnectTimer) this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.deps.document?.visibilityState === "hidden" && this.hiddenTimer === null) this.setStatus("paused");
      else this.open();
    }, delay);
  }

  private armHiddenTimer(): void {
    if (this.hiddenTimer) return;
    this.hiddenTimer = this.deps.setTimeout(() => {
      this.hiddenTimer = null;
      if (this.deps.document?.visibilityState !== "hidden") return;
      const status = this.snapshot.status;
      if (status === "open" || status === "connecting" || status === "down") {
        this.closeSource();
        if (this.reconnectTimer) {
          this.deps.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.setStatus("paused");
      }
    }, HIDDEN_CLOSE_MS);
  }

  private onVisibility = (): void => {
    if (this.deps.document?.visibilityState === "hidden") {
      this.armHiddenTimer();
      return;
    }
    if (this.hiddenTimer) {
      this.deps.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.snapshot.status === "paused" && this.listeners.size > 0) this.open();
  };
}

let instance: MessagingLive | null = null;

/** The tab's live client (browser only). */
export function messagingLive(): MessagingLive {
  instance ??= new MessagingLive({
    openStream: (url) => new EventSource(url),
    fetchUnread,
    refreshSession,
    document: typeof document === "undefined" ? null : document,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    random: Math.random,
  });
  return instance;
}
