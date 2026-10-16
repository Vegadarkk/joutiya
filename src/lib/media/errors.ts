import type { UploadRejectReason } from "@/lib/contracts/media";

// Typed failure of the photo pipeline: the reason is the `uploads/{id}.rejectReason` value the
// caller stores and the client translates. Messages are short English hints for logs, never
// user-facing, and never contain file contents or names.

export class MediaError extends Error {
  readonly reason: UploadRejectReason;

  constructor(reason: UploadRejectReason, message?: string, options: { cause?: unknown } = {}) {
    super(message ?? reason, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MediaError";
    this.reason = reason;
  }
}

export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}
