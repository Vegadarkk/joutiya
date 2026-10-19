import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as AgentQueue from "@/lib/ai/queue";

// The worker's bootstrap (src/worker/index.ts) wires the agent queue like the four others (design
// D19, audit D1b-01): one consumer from createAgentWorker on the shared connection, listed at
// start-up, closed on SIGTERM with the others together with the producer (closeAgentQueue). And
// the consumer itself (src/worker/jobs/agent.ts): queue "agent", concurrency 1, a malformed
// payload never retries, `final` on the last attempt, Sentry on the final failure only.
// Everything below BullMQ is mocked: no Valkey, no Firestore, no provider.

const mocks = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly close = vi.fn(async () => undefined);
    constructor(
      readonly name: string,
      readonly processor: (job: unknown) => Promise<unknown>,
      readonly options: Record<string, unknown>,
    ) {
      FakeWorker.instances.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
  }
  class FakeQueue {
    readonly upsertJobScheduler = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    constructor(readonly name: string) {}
  }
  class FakeRedis {
    readonly set = vi.fn(async () => "OK");
    readonly quit = vi.fn(async () => "OK");
  }
  class UnrecoverableError extends Error {}
  class DelayedError extends Error {}
  return {
    FakeWorker,
    FakeQueue,
    FakeRedis,
    UnrecoverableError,
    DelayedError,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
    captureServerException: vi.fn(),
    closeAgentQueue: vi.fn(async () => undefined),
    runAgentTask: vi.fn(async () => ({ status: "done" })),
    outboxWatch: { stop: vi.fn() },
  };
});

vi.mock("bullmq", () => ({ Worker: mocks.FakeWorker, Queue: mocks.FakeQueue, UnrecoverableError: mocks.UnrecoverableError, DelayedError: mocks.DelayedError }));
vi.mock("ioredis", () => ({ Redis: mocks.FakeRedis }));
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ QUEUE_REDIS_URL: "redis://valkey-queue:6379" }) }));
vi.mock("@/lib/health", () => ({ WORKER_HEARTBEAT_KEY: "worker:heartbeat", WORKER_HEARTBEAT_TTL: 90 }));
vi.mock("@/lib/logging/logger", () => ({ logger: mocks.logger }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: mocks.captureServerException }));
vi.mock("@/lib/observability/sentry-server", () => ({ flushObservability: vi.fn(async () => undefined), initServerObservability: vi.fn() }));
vi.mock("@/lib/mail/deliver", () => ({ deliverMail: vi.fn(), MailDeferredError: class extends Error {} }));
vi.mock("@/lib/mail/render", () => ({ isTemplateMail: () => true }));
vi.mock("@/lib/mail/send", () => ({ closeMailQueue: vi.fn(async () => undefined), MAIL_QUEUE: "mail" }));
vi.mock("@/lib/media/classify", () => ({ checkModelsAtStartup: vi.fn(async () => undefined), resetImageClassifier: vi.fn(async () => undefined) }));
vi.mock("@/lib/media/queue", () => ({ closeMediaQueue: vi.fn(async () => undefined), MEDIA_CONCURRENCY: 1, MEDIA_QUEUE: "media" }));
vi.mock("@/lib/firebase/admin", () => ({ isFirebaseConfigured: () => true }));
vi.mock("@/lib/search/types", () => ({ SearchUnavailableError: class extends Error {} }));
vi.mock("@/lib/search/queue", () => ({
  closeSearchQueue: vi.fn(async () => undefined),
  enqueueIndexJobs: vi.fn(),
  indexJobSchema: { safeParse: () => ({ success: false }) },
  OUTBOX_POLL_JOB: "outbox-poll",
  SEARCH_QUEUE: "search",
}));
vi.mock("@/lib/startup/checks", () => ({ runStartupChecks: vi.fn(async () => undefined) }));
vi.mock("@/lib/help/search", () => ({ syncHelpIndex: vi.fn(async () => false) }));
vi.mock("@/lib/valkey/clients", () => ({ clientOptions: (_role: string, overrides: object) => ({ ...overrides }) }));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({ ...(await importOriginal<typeof AgentQueue>()), closeAgentQueue: mocks.closeAgentQueue }));
vi.mock("@/lib/ai/run", () => ({ runAgentTask: mocks.runAgentTask }));
// The real agent consumer, without the other job modules (Firestore, storage, mail).
vi.mock("@/worker/jobs", async () => {
  const agent = await import("@/worker/jobs/agent");
  return { JOBS: {}, SYSTEM_QUEUE: "system", SCHEDULES: {}, AGENT_QUEUE: agent.AGENT_QUEUE, AGENT_CONCURRENCY: agent.AGENT_CONCURRENCY, createAgentWorker: agent.createAgentWorker, processAgentJob: agent.processAgentJob };
});
vi.mock("@/worker/system-queue", () => ({ onSystemJobFailed: vi.fn(async () => undefined), syncSchedulers: vi.fn(async () => []) }));
vi.mock("@/worker/jobs/media", () => ({ onMediaJobFailed: vi.fn(async () => false), processMediaJob: vi.fn() }));
vi.mock("@/worker/jobs/search", () => ({
  ensureEngineReady: vi.fn(async () => undefined),
  holdFailedListing: vi.fn(),
  OUTBOX_POLL_EVERY_MS: 60_000,
  OUTBOX_POLL_SCHEDULER: "outbox-poll",
  processSearchJob: vi.fn(),
  watchSearchOutbox: vi.fn(() => mocks.outboxWatch),
}));

const { processAgentJob } = await import("@/worker/jobs/agent");

const signals = new Map<string, () => void>();
// Spies made here run before the first test: restoreMocks (vitest config) only restores them after it.
vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
  signals.set(event, listener);
  return process;
}) as typeof process.on);

const workers = () => mocks.FakeWorker.instances;
const agentWorker = () => workers().find((worker) => worker.name === "agent");

/** The "worker started" log line (restoreMocks clears the call history before the first test). */
let started: unknown;

beforeAll(async () => {
  await import("@/worker/index");
  await vi.waitFor(() => expect(mocks.logger.info).toHaveBeenCalledWith(expect.objectContaining({ queues: expect.any(Array) }), "worker started"));
  started = mocks.logger.info.mock.calls.find(([, message]) => message === "worker started")?.[0];
});

describe("worker bootstrap", () => {
  it("starts the agent consumer on the shared connection, at concurrency 1, and lists its queue", () => {
    expect(workers().map((worker) => worker.name)).toEqual(["system", "mail", "media", "search", "agent"]);
    const agent = agentWorker()!;
    const system = workers()[0]!;
    expect(agent.options).toMatchObject({ concurrency: 1 });
    expect(agent.options.connection).toBeInstanceOf(mocks.FakeRedis);
    expect(agent.options.connection).toBe(system.options.connection);
    expect(started).toEqual({ queues: ["system", "mail", "media", "search", "agent"] });
  });

  it("logs every failure and reports the final one (or an unrecoverable payload) to Sentry", () => {
    const failed = agentWorker()!.listeners.get("failed")!;
    const error = new Error("boom");
    failed({ name: "ai-task", attemptsMade: 1, opts: { attempts: 3 } }, error);
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ queue: "agent", job: "ai-task", attempt: 1, err: "boom" }), "agent job failed");
    expect(mocks.captureServerException).not.toHaveBeenCalled();
    failed({ name: "ai-task", attemptsMade: 3, opts: { attempts: 3 } }, error);
    expect(mocks.captureServerException).toHaveBeenCalledExactlyOnceWith(error, { queue: "agent", job: "ai-task" });
    failed({ name: "ai-task", attemptsMade: 1, opts: { attempts: 3 } }, new mocks.UnrecoverableError("invalid agent job"));
    expect(mocks.captureServerException).toHaveBeenCalledTimes(2);
  });

  it("runs the task with `final` on the last attempt only and never retries a malformed payload", async () => {
    const job = (data: unknown, attemptsMade: number) => ({ id: "j1", data, attemptsMade, opts: { attempts: 3 } });
    const data = { task: "listing_screen", target: { type: "listing", id: "abcdefgh" } };
    await processAgentJob(job(data, 0) as never);
    expect(mocks.runAgentTask).toHaveBeenLastCalledWith(data, { final: false });
    await processAgentJob(job(data, 2) as never);
    expect(mocks.runAgentTask).toHaveBeenLastCalledWith(data, { final: true });
    await expect(processAgentJob(job({ task: "listing_screen", target: { type: "report", id: "r1" } }, 0) as never)).rejects.toBeInstanceOf(mocks.UnrecoverableError);
    expect(mocks.runAgentTask).toHaveBeenCalledTimes(2);
  });

  it("closes the agent consumer and producer with the others on SIGTERM", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    for (const worker of workers()) expect(worker.close).toHaveBeenCalledOnce();
    expect(mocks.closeAgentQueue).toHaveBeenCalledOnce();
    expect(mocks.outboxWatch.stop).toHaveBeenCalledOnce();
  });
});
