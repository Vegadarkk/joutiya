import { UnrecoverableError, type Job } from "bullmq";
import { logger } from "@/lib/logging/logger";
import { billingJobSchema } from "@/lib/payments/billing-queue";
import { onBillingEventAbandoned, processBillingEvent, type ProcessOutcome } from "@/lib/payments/revenuecat-events";

// Processor of the "billing" queue (phase 7 design §6, concurrency 1): one RevenueCat event per
// job. A purchase not yet visible in RevenueCat or an unavailable API throws and BullMQ retries;
// the last failed attempt alerts so an admin checks the purchase by hand.

export async function processBillingJob(job: Pick<Job, "id" | "data">): Promise<ProcessOutcome> {
  const data = billingJobSchema.safeParse(job.data);
  // Payloads are ours, but a malformed one must not burn eight attempts.
  if (!data.success) throw new UnrecoverableError(`invalid billing job ${job.id ?? ""}`);
  return processBillingEvent(data.data.eventId);
}

/** "failed" listener: true when this was the final attempt (alerted). */
export async function onBillingJobFailed(job: Pick<Job, "data" | "attemptsMade" | "opts"> | undefined, error: Error): Promise<boolean> {
  const data = billingJobSchema.safeParse(job?.data);
  if (!job || !data.success) return false;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
  if (!final) return false;
  try {
    await onBillingEventAbandoned(data.data.eventId, error);
  } catch (cause) {
    logger.error({ eventId: data.data.eventId, err: (cause as Error).message }, "billing failure not alerted");
  }
  return true;
}
