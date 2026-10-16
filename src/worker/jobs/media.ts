import { UnrecoverableError, type Job } from "bullmq";
import type { UploadStatusResponse } from "@/lib/contracts/media";
import { logger } from "@/lib/logging/logger";
import { expireUpload, processUpload } from "@/lib/media/pipeline";
import { isMediaJobData } from "@/lib/media/queue";

// Processor of the "media" queue (D12, concurrency 1): one upload per job. Media failures end as
// rejections inside the pipeline; infrastructure failures throw, BullMQ retries them, and the last
// failed attempt expires the upload so the wizard stops waiting and offers a retry.

export async function processMediaJob(job: Pick<Job, "id" | "data">): Promise<UploadStatusResponse | null> {
  // Payloads are ours, but a malformed one must not burn three attempts.
  if (!isMediaJobData(job.data)) throw new UnrecoverableError(`invalid media job ${job.id ?? ""}`);
  return processUpload(job.data.uploadId);
}

/** "failed" listener: after the final attempt the upload is expired (objects deleted best effort). */
export async function onMediaJobFailed(job: Pick<Job, "data" | "attemptsMade" | "opts"> | undefined, error: Error): Promise<boolean> {
  if (!job || !isMediaJobData(job.data)) return false;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
  if (!final) return false;
  try {
    await expireUpload(job.data.uploadId);
    return true;
  } catch (cause) {
    // Still `processing`: purge-quarantine expires it after 24 h.
    logger.error({ uploadId: job.data.uploadId, err: (cause as Error).message }, "upload not expired after the last attempt");
    return false;
  }
}
