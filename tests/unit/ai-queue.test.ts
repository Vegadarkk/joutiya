import { afterEach, describe, expect, it, vi } from "vitest";

// The agent queue's producer (design D19, audit D1b-04) with BullMQ mocked: the job id carries the
// listing version when given (a republish is screened even while an older job runs or just
// failed), the job options keep a failed id for one hour only, and a slow add times out.

const mocks = vi.hoisted(() => ({
  add: vi.fn(async () => ({ id: "job" })),
  env: { QUEUE_REDIS_URL: "redis://valkey-queue:6379" as string | undefined },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    readonly add = mocks.add;
    readonly close = vi.fn(async () => undefined);
    constructor(readonly name: string) {}
  },
}));
vi.mock("ioredis", () => ({
  Redis: class {
    readonly quit = vi.fn(async () => "OK");
  },
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => mocks.env }));
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/valkey/clients", () => ({ clientOptions: (_role: string, overrides: object) => ({ ...overrides }) }));

const { AGENT_JOB, AGENT_JOB_OPTIONS, closeAgentQueue, enqueueAiTask, ENQUEUE_TIMEOUT_MS } = await import("@/lib/ai/queue");

afterEach(async () => {
  await closeAgentQueue();
  mocks.add.mockClear();
  vi.useRealTimers();
});

describe("enqueueAiTask", () => {
  it("adds a listing_screen job under the listing's version", async () => {
    expect(await enqueueAiTask("listing_screen", { type: "listing", id: "abcdefgh" }, { version: 3 })).toEqual({ queued: true });
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(AGENT_JOB, { task: "listing_screen", target: { type: "listing", id: "abcdefgh" } }, { ...AGENT_JOB_OPTIONS, jobId: "listing_screen-abcdefgh-v3" });
    await enqueueAiTask("listing_screen", { type: "listing", id: "abcdefgh" }, { version: 4 });
    expect(mocks.add).toHaveBeenLastCalledWith(AGENT_JOB, expect.anything(), expect.objectContaining({ jobId: "listing_screen-abcdefgh-v4" }));
  });

  it("keeps one job per report or decision without a version", async () => {
    await enqueueAiTask("report_triage", { type: "report", id: "r1" });
    expect(mocks.add).toHaveBeenLastCalledWith(AGENT_JOB, expect.anything(), expect.objectContaining({ jobId: "report_triage-r1", removeOnFail: { age: 3_600, count: 500 } }));
  });

  it("gives up after the enqueue timeout instead of holding the request", async () => {
    vi.useFakeTimers();
    mocks.add.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = enqueueAiTask("report_triage", { type: "report", id: "r2" });
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS + 1);
    expect(await outcome).toBe("agent job not enqueued in time");
  });
});
