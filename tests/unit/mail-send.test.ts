import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateMail } from "@/lib/mail/types";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/mail/deliver", () => ({
  deliverMail: vi.fn(async () => ({ provider: "memory", id: "m" })),
  MailDeferredError: class extends Error {
    constructor(
      readonly retryAt: Date,
      message: string,
    ) {
      super(message);
      this.name = "MailDeferredError";
    }
  },
}));

const queues: { name: string; add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
const redisClients: { url: string; options: Record<string, unknown>; quit: ReturnType<typeof vi.fn> }[] = [];

vi.mock("bullmq", () => ({
  Queue: class {
    add = vi.fn(async () => ({ id: "job" }));
    close = vi.fn(async () => undefined);
    constructor(readonly name: string) {
      queues.push(this);
    }
  },
}));
vi.mock("ioredis", () => ({
  Redis: class {
    quit = vi.fn(async () => "OK");
    constructor(
      readonly url: string,
      readonly options: Record<string, unknown>,
    ) {
      redisClients.push(this);
    }
  },
}));

const { deliverMail, MailDeferredError } = await import("@/lib/mail/deliver");
const { logger } = await import("@/lib/logging/logger");
const { resetServerEnv } = await import("@/lib/env");
const { closeMailQueue, enqueueMail, MAIL_JOB_OPTIONS, MAIL_QUEUE, sanitizeJobId } = await import("@/lib/mail/send");
const { sendMail } = await import("@/lib/mail");

const MAIL: TemplateMail<"verifyEmail"> = {
  template: "verifyEmail",
  locale: "fr",
  to: "nadia@example.com",
  data: { displayName: "Nadia", actionUrl: "https://joutiya.test/fr/action" },
  priority: "security",
  idempotencyKey: "verify:uid-1:497000",
};

beforeEach(() => {
  queues.length = 0;
  redisClients.length = 0;
  vi.mocked(deliverMail).mockReset();
  vi.mocked(deliverMail).mockResolvedValue({ provider: "memory", id: "m" });
});

afterEach(async () => {
  await closeMailQueue();
  delete process.env.QUEUE_REDIS_URL;
  resetServerEnv();
});

describe("sanitizeJobId", () => {
  it("keeps safe keys and makes colon-separated ones unique and colon-free", () => {
    expect(sanitizeJobId("verify-uid-1-497000")).toBe("verify-uid-1-497000");
    const a = sanitizeJobId("verify:uid-1:497000");
    const b = sanitizeJobId("verify-uid-1:497000");
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.startsWith("verify_uid-1_497000-")).toBe(true);
    expect(a).not.toBe(b);
    expect(sanitizeJobId("x".repeat(300)).length).toBeLessThanOrEqual(131);
  });
});

describe("enqueueMail", () => {
  it("delivers inline when no queue is configured", async () => {
    resetServerEnv();
    await enqueueMail(MAIL);
    expect(deliverMail).toHaveBeenCalledWith(MAIL);
    expect(queues).toHaveLength(0);
    expect(redisClients).toHaveLength(0);
  });

  it("drops a deferred mail inline, with a warning, and rethrows anything else", async () => {
    resetServerEnv();
    vi.mocked(deliverMail).mockRejectedValueOnce(new MailDeferredError(new Date("2026-10-17T00:01:00Z"), "quotas exhausted"));
    await expect(enqueueMail(MAIL)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ retryAt: "2026-10-17T00:01:00.000Z" }), "mail dropped: no queue to defer it");
    vi.mocked(deliverMail).mockRejectedValueOnce(new Error("network"));
    await expect(enqueueMail(MAIL)).rejects.toThrow("network");
  });

  it("adds a prioritised, deduplicated job on the mail queue otherwise", async () => {
    process.env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    resetServerEnv();
    await enqueueMail(MAIL);
    await enqueueMail({ ...MAIL, priority: undefined, idempotencyKey: undefined });
    await enqueueMail({ ...MAIL, priority: "bulk", idempotencyKey: "digest-1" });
    expect(deliverMail).not.toHaveBeenCalled();
    expect(redisClients).toHaveLength(1);
    expect(redisClients[0]).toMatchObject({ url: "redis://valkey-queue:6379", options: { maxRetriesPerRequest: null, lazyConnect: false } });
    expect(queues).toHaveLength(1);
    expect(queues[0]?.name).toBe(MAIL_QUEUE);
    expect(MAIL_QUEUE).toBe("mail");
    const add = queues[0]?.add;
    expect(add).toHaveBeenCalledTimes(3);
    expect(add?.mock.calls[0]).toEqual([
      "verifyEmail",
      MAIL,
      {
        jobId: sanitizeJobId("verify:uid-1:497000"),
        priority: 1,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        // Payloads hold live action links: finished jobs leave Valkey at once, failed ones within the hour.
        removeOnComplete: true,
        removeOnFail: { age: 3_600, count: 200 },
      },
    ]);
    expect(MAIL_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(add?.mock.calls[1]?.[2]).toMatchObject({ priority: 5 });
    expect(add?.mock.calls[1]?.[2]).not.toHaveProperty("jobId");
    expect(add?.mock.calls[2]?.[2]).toMatchObject({ priority: 10, jobId: "digest-1" });
  });

  it("closes the queue and its connection", async () => {
    process.env.QUEUE_REDIS_URL = "redis://valkey-queue:6379";
    resetServerEnv();
    await enqueueMail(MAIL);
    await closeMailQueue();
    expect(queues[0]?.close).toHaveBeenCalledTimes(1);
    expect(redisClients[0]?.quit).toHaveBeenCalledTimes(1);
    // A later send opens a fresh queue.
    await enqueueMail(MAIL);
    expect(queues).toHaveLength(2);
  });

  it("is what sendMail calls", async () => {
    resetServerEnv();
    await sendMail(MAIL);
    expect(deliverMail).toHaveBeenCalledWith(MAIL);
  });
});
