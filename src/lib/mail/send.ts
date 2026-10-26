import "server-only";
import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { clientOptions } from "@/lib/valkey/clients";
import { deliverMail, MailDeferredError } from "./deliver";
import type { MailPriority, TemplateId, TemplateMail } from "./types";

// The web app enqueues on valkey-queue (the worker delivers, with retries and priorities); without
// QUEUE_REDIS_URL (local dev) the mail is delivered inline.

export const MAIL_QUEUE = "mail";

const PRIORITY: Record<MailPriority, number> = { security: 1, transactional: 5, bulk: 10 };

// Five quick attempts cover transient failures (429 rate limit, 5xx, network); a spent or refused
// quota (a transactional mail from 90 % of Resend, a 429 for its quota) or an unavailable provider
// delays the job instead (MailDeferredError, src/worker/index.ts).
// The payload holds the template data, action links included (live oobCodes): a finished job
// leaves Valkey at once and a failed one within the hour (200 kept at most for diagnosis).
// Later phase: generate the links at delivery time so the queue never holds them.
export const MAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 3_600, count: 200 },
} as const;

/**
 * BullMQ custom job ids must not contain ":" (the key separator). Keeps [A-Za-z0-9_-], replaces
 * the rest with "_" and appends a short digest so two different keys never collide once cleaned.
 */
export function sanitizeJobId(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  if (clean === key) return clean;
  return `${clean}-${createHash("sha256").update(key).digest("base64url").slice(0, 10)}`;
}

let queue: Queue | undefined;
let connection: Redis | undefined;

function mailQueue(url: string): Queue {
  if (queue) return queue;
  connection = new Redis(url, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  queue = new Queue(MAIL_QUEUE, { connection });
  return queue;
}

export async function enqueueMail<T extends TemplateId>(mail: TemplateMail<T>): Promise<void> {
  const env = serverEnv();
  if (!env.QUEUE_REDIS_URL) {
    try {
      await deliverMail(mail);
    } catch (error) {
      if (!(error instanceof MailDeferredError)) throw error;
      // Local dev only (deployed envs require the queue): nothing can hold the mail until then.
      logger.warn({ template: mail.template, retryAt: error.retryAt.toISOString(), reason: error.message }, "mail dropped: no queue to defer it");
    }
    return;
  }
  await mailQueue(env.QUEUE_REDIS_URL).add(mail.template, mail, {
    ...MAIL_JOB_OPTIONS,
    ...(mail.idempotencyKey ? { jobId: sanitizeJobId(mail.idempotencyKey) } : {}),
    priority: PRIORITY[mail.priority ?? "transactional"],
  });
}

/** Tests and shutdown: closes the queue and its connection. */
export async function closeMailQueue(): Promise<void> {
  const current = queue;
  const client = connection;
  queue = undefined;
  connection = undefined;
  await current?.close();
  await client?.quit().catch(() => undefined);
}
