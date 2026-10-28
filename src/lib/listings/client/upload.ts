import { ApiError, uploadToPresignedUrl } from "@/lib/auth/client";
import type { ListingPhoto, UploadRejectReason, UploadStatusResponse } from "@/lib/contracts/media";
import { completeUpload, deleteUpload, pollUpload, signUpload, type PollOptions } from "./api";
import { prepareImage, PrepareImageError, type PrepareOptions, type PreparedImage } from "./prepare-image";

// One photo, end to end (design §3): prepare in the browser -> POST /api/uploads/sign -> PUT the
// blob to the presigned URL (progress, abort) -> POST /api/uploads/{id}/complete -> poll while
// the pipeline runs. Pure orchestration, unit-tested with injected prepare/upload/poll. A
// cancelled upload rejects with ApiError "aborted" and, once signed, deletes its upload record so
// the quarantine object and the photo slot are freed at once. Aborted with LEAVE_REASON (the page
// goes away), a completed upload is kept: the pipeline attaches it and the next visit shows it.

export type PhotoUploadPhase =
  | { phase: "preparing" }
  | { phase: "uploading"; progress: number; uploadId: string }
  | { phase: "processing"; uploadId: string }
  /** `faces`: faces the local check found on the photo (the wizard proposes a crop). */
  | { phase: "ready"; uploadId: string; photo: ListingPhoto; faces?: number }
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
  /** Deletes a signed upload after a cancellation (default DELETE /api/uploads/{id}). */
  discard?: (id: string) => Promise<void>;
}

export interface UploadPhotoResult {
  uploadId: string;
  prepared: PreparedImage;
  status: UploadStatusResponse;
}

const aborted = () => new ApiError(0, "aborted");

/** `controller.abort(LEAVE_REASON)`: stop following the upload without cancelling it once completed. */
export const LEAVE_REASON = "leave";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

export async function uploadListingPhoto(listingId: string, file: Blob, options: UploadPhotoOptions = {}): Promise<UploadPhotoResult> {
  const { onPhase, signal } = options;
  const prepare = options.prepare ?? prepareImage;
  const put = options.put ?? uploadToPresignedUrl;
  const sign = options.sign ?? signUpload;
  const complete = options.complete ?? completeUpload;
  const poll = options.poll ?? pollUpload;
  const discard = options.discard ?? deleteUpload;

  throwIfAborted(signal);
  onPhase?.({ phase: "preparing" });
  const prepared = await prepare(file, options.prepareOptions);
  throwIfAborted(signal);

  const signed = await sign({ purpose: "listing", targetId: listingId, declaredSize: prepared.blob.size, declaredType: prepared.type });
  const uploadId = signed.uploadId;
  let status: UploadStatusResponse;
  let completed = false;
  try {
    throwIfAborted(signal);
    onPhase?.({ phase: "uploading", progress: 0, uploadId });
    await put(signed.url, signed.headers, prepared.blob, (fraction) => onPhase?.({ phase: "uploading", progress: fraction, uploadId }), signal);
    throwIfAborted(signal);

    onPhase?.({ phase: "processing", uploadId });
    status = await complete(uploadId);
    completed = true;
    throwIfAborted(signal);
    if (status.status === "processing") {
      status = await poll(uploadId, { ...options.pollOptions, signal });
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    if (!(completed && signal.reason === LEAVE_REASON)) void discard(uploadId).catch(() => undefined);
    throw aborted();
  }
  if (status.status === "ready") onPhase?.({ phase: "ready", uploadId, photo: status.photo, ...(status.faces ? { faces: status.faces } : {}) });
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
