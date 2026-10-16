import { ApiError, uploadToPresignedUrl } from "@/lib/auth/client";
import type { ListingPhoto, UploadRejectReason, UploadStatusResponse } from "@/lib/contracts/media";
import { completeUpload, pollUpload, signUpload, type PollOptions } from "./api";
import { prepareImage, PrepareImageError, type PrepareOptions, type PreparedImage } from "./prepare-image";

// One photo, end to end (design §3): prepare in the browser -> POST /api/uploads/sign -> PUT the
// blob to the presigned URL (progress, abort) -> POST /api/uploads/{id}/complete -> poll while
// the pipeline runs. Pure orchestration, unit-tested with injected prepare/upload/poll.

export type PhotoUploadPhase =
  | { phase: "preparing" }
  | { phase: "uploading"; progress: number; uploadId: string }
  | { phase: "processing"; uploadId: string }
  | { phase: "ready"; uploadId: string; photo: ListingPhoto }
  | { phase: "rejected"; uploadId: string; reason: UploadRejectReason }
  /** The deadline passed while still processing: the caller polls again on demand. */
  | { phase: "timeout"; uploadId: string };

export interface UploadPhotoOptions {
  onPhase?: (phase: PhotoUploadPhase) => void;
  signal?: AbortSignal;
  prepare?: (file: Blob, options?: PrepareOptions) => Promise<PreparedImage>;
  prepareOptions?: PrepareOptions;
  put?: typeof uploadToPresignedUrl;
  sign?: typeof signUpload;
  complete?: typeof completeUpload;
  poll?: (id: string, options?: PollOptions) => Promise<UploadStatusResponse>;
  pollOptions?: PollOptions;
}

export interface UploadPhotoResult {
  uploadId: string;
  prepared: PreparedImage;
  status: UploadStatusResponse;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApiError(0, "aborted");
}

export async function uploadListingPhoto(listingId: string, file: Blob, options: UploadPhotoOptions = {}): Promise<UploadPhotoResult> {
  const { onPhase, signal } = options;
  const prepare = options.prepare ?? prepareImage;
  const put = options.put ?? uploadToPresignedUrl;
  const sign = options.sign ?? signUpload;
  const complete = options.complete ?? completeUpload;
  const poll = options.poll ?? pollUpload;

  onPhase?.({ phase: "preparing" });
  const prepared = await prepare(file, options.prepareOptions);
  throwIfAborted(signal);

  const signed = await sign({ purpose: "listing", targetId: listingId, declaredSize: prepared.blob.size, declaredType: prepared.type });
  const uploadId = signed.uploadId;
  throwIfAborted(signal);

  onPhase?.({ phase: "uploading", progress: 0, uploadId });
  await put(signed.url, signed.headers, prepared.blob, (fraction) => onPhase?.({ phase: "uploading", progress: fraction, uploadId }), signal);

  onPhase?.({ phase: "processing", uploadId });
  let status = await complete(uploadId);
  if (status.status === "processing") {
    status = await poll(uploadId, { ...options.pollOptions, signal });
  }
  if (status.status === "ready") onPhase?.({ phase: "ready", uploadId, photo: status.photo });
  else if (status.status === "rejected") onPhase?.({ phase: "rejected", uploadId, reason: status.rejectReason });
  else onPhase?.({ phase: "timeout", uploadId });
  return { uploadId, prepared, status };
}

/** Error code of a failed upload, for `Listing.errors` / `Listing.photos`. */
export function uploadErrorCode(error: unknown): string {
  if (error instanceof PrepareImageError) return error.code;
  if (error instanceof ApiError) return error.code;
  return "internal";
}
