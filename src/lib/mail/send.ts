import "server-only";
import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { serverEnv } from "@/lib/env";
import { clientOptions } from "@/lib/valkey/clients";
import { deliverMail } from "./deliver";
import type { MailPriority, TemplateId, TemplateMail } from "./types";

// The web app enqueues on valkey-queue (the worker delivers, with retries and priorities); without
// QUEUE_REDIS_URL (local dev) the mail is delivered inline.

export const MAIL_QUEUE = "mail";

const PRIORITY: Record<MailPriority, number> = { security: 1, transactional: 5, bulk: 10 };

export const MAIL_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
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
    await deliverMail(mail);
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
