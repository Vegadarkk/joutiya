import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const valkeyState = vi.hoisted(() => ({
  configured: false,
  lag: null as string | null,
  getFails: false,
}));

vi.mock("@/lib/valkey/clients", () => ({
  isValkeyConfigured: () => valkeyState.configured,
  pingValkey: async () => true,
  valkey: () => ({
    exists: async () => 1,
    get: async (key: string) => {
      if (valkeyState.getFails) throw new Error("down");
      return key === "search:outbox:lagSeconds" ? valkeyState.lag : null;
    },
  }),
}));

const { healthReport } = await import("@/lib/health");
const { resetServerEnv } = await import("@/lib/env");
const { resetSearchEngine, setSearchEngineForTests } = await import("@/lib/search/engine");
const { SEARCH_LAG_KEY } = await import("@/lib/search/indexer");
const { MemoryEngine } = await import("@/lib/search/memory");

function engine(healthy: () => Promise<boolean>) {
  return Object.assign(new MemoryEngine(), { healthy });
}

describe("health report: search (informational)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, APP_ENV: "dev" };
    delete process.env.MEILI_URL;
    delete process.env.MEILI_SEARCH_KEY;
    delete process.env.MEILI_INDEX_KEY;
    resetServerEnv();
    Object.assign(valkeyState, { configured: false, lag: null, getFails: false });
  });
  afterEach(() => {
    process.env = { ...saved };
    resetServerEnv();
    resetSearchEngine();
    vi.useRealTimers();
  });

  it("skips Meilisearch in development on the memory engine", async () => {
    const report = await healthReport();
    expect(report.status).toBe("ok");
    expect(report.info).toEqual({ meilisearch: "skipped", searchLagSeconds: null });
  });

  it("reports a failing Meilisearch without degrading the status", async () => {
    process.env.MEILI_URL = "http://127.0.0.1:7700";
    process.env.MEILI_SEARCH_KEY = "s";
    resetServerEnv();
    setSearchEngineForTests(engine(async () => false));
    expect(await healthReport()).toMatchObject({ status: "ok", info: { meilisearch: "fail" } });
    setSearchEngineForTests(engine(async () => true));
    expect((await healthReport()).info.meilisearch).toBe("ok");
    setSearchEngineForTests(engine(async () => Promise.reject(new Error("boom"))));
    expect((await healthReport()).info.meilisearch).toBe("fail");
  });

  it("fails after one second when Meilisearch hangs", async () => {
    process.env.MEILI_URL = "http://127.0.0.1:7700";
    process.env.MEILI_SEARCH_KEY = "s";
    resetServerEnv();
    setSearchEngineForTests(engine(() => new Promise<boolean>(() => undefined)));
    vi.useFakeTimers();
    const pending = healthReport();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).info.meilisearch).toBe("fail");
  });

  it("reports a missing MEILI_URL outside development as a failure", async () => {
    process.env.APP_ENV = "staging";
    resetServerEnv();
    expect((await healthReport()).info.meilisearch).toBe("fail");
  });

  it("reads the indexing lag the worker stores in valkey-queue", async () => {
    expect(SEARCH_LAG_KEY).toBe("search:outbox:lagSeconds");
    valkeyState.configured = true;
    valkeyState.lag = "42.4";
    const report = await healthReport();
    expect(report.checks).toEqual({ valkeyQueue: "ok", valkeyRateLimit: "ok", worker: "ok" });
    expect(report.info.searchLagSeconds).toBe(42);
    valkeyState.lag = "not a number";
    expect((await healthReport()).info.searchLagSeconds).toBeNull();
    valkeyState.getFails = true;
    expect((await healthReport()).info.searchLagSeconds).toBeNull();
  });
});
