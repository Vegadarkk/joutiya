import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
  withScope: vi.fn(),
}));
vi.mock("@sentry/node", () => sentry);

const DSN = "https://examplePublicKey@o0.ingest.de.sentry.io/0";
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
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    });
    expect(typeof options.beforeSend).toBe("function");
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
