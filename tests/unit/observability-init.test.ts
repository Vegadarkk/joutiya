import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
  withScope: vi.fn(),
}));
vi.mock("@sentry/node", () => sentry);

// The sentry.events quota (B3-07): counted in beforeSend, read once at init.
const quota = vi.hoisted(() => ({ consume: vi.fn(), isDegraded: vi.fn() }));
vi.mock("@/lib/quota", () => quota);

const DSN = "https://examplePublicKey@o0.ingest.de.sentry.io/0";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const saved = { SENTRY_DSN: process.env.SENTRY_DSN, LOG_LEVEL: process.env.LOG_LEVEL };

async function load() {
  // Fresh module state (the "initialized once" latch and the env cache) for every test.
  vi.resetModules();
  const [observability, capture] = await Promise.all([import("@/lib/observability/sentry-server"), import("@/lib/observability/capture")]);
  return { ...observability, ...capture };
}

beforeEach(() => {
  process.env.LOG_LEVEL = "silent";
  for (const fn of Object.values(sentry)) fn.mockReset();
  quota.consume.mockReset().mockResolvedValue({ level: "ok" });
  quota.isDegraded.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("initServerObservability", () => {
  it("is a no-op without SENTRY_DSN", async () => {
    delete process.env.SENTRY_DSN;
    const { initServerObservability, observabilityActive, flushObservability, captureServerException } = await load();
    initServerObservability("web");
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.setTag).not.toHaveBeenCalled();
    expect(observabilityActive()).toBe(false);
    captureServerException(new Error("x"));
    expect(sentry.captureException).not.toHaveBeenCalled();
    await flushObservability(10);
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("initialises errors-only tracking with restricted collection and no tracing", async () => {
    process.env.SENTRY_DSN = DSN;
    const { initServerObservability, observabilityActive } = await load();
    initServerObservability("worker");
    initServerObservability("worker");
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dsn: DSN,
      environment: "dev",
      serverName: "worker",
      sampleRate: 1,
      maxBreadcrumbs: 30,
      // No sentry-trace/baggage header on outgoing requests (third parties never see a trace id).
      tracePropagationTargets: [],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    });
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
    for (const forbidden of ["tracesSampleRate", "tracesSampler", "sendDefaultPii", "integrations", "replaysSessionSampleRate", "replaysOnErrorSampleRate", "tunnel"]) {
      expect(options).not.toHaveProperty(forbidden);
    }
    expect(sentry.setTag).toHaveBeenCalledWith("service", "worker");
    expect(observabilityActive()).toBe(true);
  });

  it("forwards captured server exceptions with their context as extra", async () => {
    process.env.SENTRY_DSN = DSN;
    const { initServerObservability, captureServerException } = await load();
    initServerObservability("web");
    const error = new Error("boom");
    captureServerException(error, { job: "heartbeat" });
    expect(sentry.captureException).toHaveBeenCalledWith(error, { extra: { job: "heartbeat" } });
  });

  it("flushes on request and swallows flush failures", async () => {
    process.env.SENTRY_DSN = DSN;
    const { initServerObservability, flushObservability } = await load();
    initServerObservability("worker");
    sentry.flush.mockRejectedValueOnce(new Error("offline"));
    await expect(flushObservability(500)).resolves.toBeUndefined();
    expect(sentry.flush).toHaveBeenCalledWith(500);
  });
});

describe("beforeSend and the sentry.events quota (B3-07)", () => {
  type BeforeSend = (event: { message?: string }) => { message?: string } | null;

  async function sendingHook() {
    process.env.SENTRY_DSN = DSN;
    const { initServerObservability, beforeSendServerEvent } = await load();
    initServerObservability("web");
    // The latest init: load() gives every call a fresh module (and a fresh cached level).
    const options = sentry.init.mock.calls.at(-1)?.[0] as { beforeSend: BeforeSend };
    expect(options.beforeSend).toBe(beforeSendServerEvent);
    return options.beforeSend;
  }

  it("scrubs, counts one event per sent event and drops every event once the month's quota is degraded", async () => {
    const beforeSend = await sendingHook();
    expect(beforeSend({ message: "boom for nadia@example.com" })).toEqual({ message: "boom for [email]" });
    expect(quota.consume).toHaveBeenCalledTimes(1);
    expect(quota.consume).toHaveBeenCalledWith("sentry.events");
    // Control flow is dropped by the scrubber and never counted.
    expect(beforeSend({ message: "NEXT_REDIRECT" })).toBeNull();
    expect(quota.consume).toHaveBeenCalledTimes(1);
    // The event that crosses 90 % still leaves (counted after the decision); the next ones do not.
    quota.consume.mockResolvedValue({ level: "degraded" });
    expect(beforeSend({ message: "crossing" })).toEqual({ message: "crossing" });
    await tick();
    expect(beforeSend({ message: "dropped" })).toBeNull();
    expect(beforeSend({ message: "dropped too" })).toBeNull();
    expect(quota.consume).toHaveBeenCalledTimes(2);
  });

  it("reads the quota once at init so a restart in a spent month drops at once; unknown counts as available", async () => {
    quota.isDegraded.mockResolvedValue(true);
    const beforeSend = await sendingHook();
    expect(quota.isDegraded).toHaveBeenCalledWith("sentry.events");
    await tick();
    expect(beforeSend({ message: "boom" })).toBeNull();
    expect(quota.consume).not.toHaveBeenCalled();

    quota.isDegraded.mockResolvedValue(false);
    const fresh = await sendingHook();
    await tick();
    quota.consume.mockResolvedValue({ level: "unknown" });
    expect(fresh({ message: "sent" })).toEqual({ message: "sent" });
    await tick();
    expect(fresh({ message: "still sent" })).toEqual({ message: "still sent" });
  });

  it("never waits for Valkey nor loses an event over a failing counter", async () => {
    const beforeSend = await sendingHook();
    quota.consume.mockRejectedValue(new Error("connection closed"));
    expect(beforeSend({ message: "first" })).toEqual({ message: "first" });
    await tick();
    expect(beforeSend({ message: "second" })).toEqual({ message: "second" });
    expect(quota.consume).toHaveBeenCalledTimes(2);
  });
});
