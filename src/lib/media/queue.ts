import "server-only";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { uploadIdSchema, type UploadStatusResponse } from "@/lib/contracts/media";
import { serverEnv } from "@/lib/env";
import { clientOptions } from "@/lib/valkey/clients";
import { processUpload, type PipelineDeps } from "./pipeline";

// Queue "media" (D12): the complete route enqueues one job per upload on valkey-queue and the
// worker processes them one at a time (sharp + ONNX, bounded memory). Without QUEUE_REDIS_URL
// (local dev, tests) the pipeline runs inline in the request instead.

export const MEDIA_QUEUE = "media";
export const MEDIA_JOB = "process-upload";
/** One image at a time on the VM (§2). */
export const MEDIA_CONCURRENCY = 1;

// Three attempts cover transient storage or Firestore errors; the last failure expires the upload
// (src/worker/jobs/media.ts). Payloads hold an upload id only: nothing personal stays in Valkey.
export const MEDIA_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3_600, count: 500 },
} as const;

export interface MediaJobData {
  uploadId: string;
}

export function isMediaJobData(value: unknown): value is MediaJobData {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "uploadId" && uploadIdSchema.safeParse((value as MediaJobData).uploadId).success;
}

/** One job per upload: BullMQ ignores an add whose id is still known, so a repeated complete is harmless. */
export function mediaJobId(uploadId: string): string {
  return `upload-${uploadId}`;
}

export function isMediaQueueEnabled(env: { QUEUE_REDIS_URL?: string } = serverEnv()): boolean {
  return Boolean(env.QUEUE_REDIS_URL);
}

let queue: Queue | undefined;
let connection: Redis | undefined;

function mediaQueue(url: string): Queue {
  if (queue) return queue;
  connection = new Redis(url, clientOptions("queue", { lazyConnect: false, maxRetriesPerRequest: null }));
  queue = new Queue(MEDIA_QUEUE, { connection });
  return queue;
}

export async function enqueueMediaJob(uploadId: string): Promise<void> {
  const url = serverEnv().QUEUE_REDIS_URL;
  if (!url) throw new Error("QUEUE_REDIS_URL is not set: the media queue is disabled");
  const data: MediaJobData = { uploadId: uploadIdSchema.parse(uploadId) };
  await mediaQueue(url).add(MEDIA_JOB, data, { ...MEDIA_JOB_OPTIONS, jobId: mediaJobId(uploadId) });
}

/**
 * Processing of an upload the complete route just moved to `processing`: queued with Valkey (the
 * answer is `processing`, the client polls), inline otherwise (the answer is final).
 */
export async function dispatchUpload(uploadId: string, deps: PipelineDeps = {}): Promise<UploadStatusResponse | null> {
  if (isMediaQueueEnabled()) {
    await enqueueMediaJob(uploadId);
    return { status: "processing" };
  }
  return processUpload(uploadId, deps);
}

/** Tests and shutdown: closes the producer and its connection. */
export async function closeMediaQueue(): Promise<void> {
  const current = queue;
  const client = connection;
  queue = undefined;
  connection = undefined;
  await current?.close();
  await client?.quit().catch(() => undefined);
}
