import { z } from "@/lib/zod";
import { LISTING_ID_PATTERN } from "@/lib/listings/ids";
import { PHOTO_VARIANTS } from "./photo-variants";

// Shared client/server contracts of the uploads API (phase 3, design §3 and D6). Client-safe: no
// env, no db. The browser resizes (<= 2048 px JPEG/WebP, HEIC converted locally), asks for a
// presigned PUT, uploads straight to the quarantine bucket, then calls `complete`; the pipeline
// (worker, or inline without Valkey) produces the WebP variants and attaches the photo.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTOS_INDIVIDUAL = 10;
export const MAX_PHOTOS_PRO = 20;
/**
 * Upload documents one listing may hold at once (attached, in flight, refused ones kept 7 days):
 * this many times its photo limit. Past it, signing answers 409 `upload_limit` (not `photo_limit`:
 * the listing may still have room for photos): the owner removes refused photos (DELETE frees the
 * slot) or waits for purge-quarantine to delete them.
 */
export const UPLOADS_PER_PHOTO_SLOT = 3;
/** Longest edge the browser sends; anything larger is resized client-side first. */
export const MAX_CLIENT_EDGE_PX = 2048;
/** Presigned PUT validity (architecture §6). */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;

export const UPLOAD_DECLARED_TYPES = ["image/jpeg", "image/webp", "image/png"] as const;
export type UploadDeclaredType = (typeof UPLOAD_DECLARED_TYPES)[number];

/** `uploads/{id}.status`: signed -> processing -> ready | rejected. */
export const UPLOAD_STATUSES = ["signed", "processing", "ready", "rejected"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const UPLOAD_REJECT_REASONS = ["too_large", "bad_type", "decode_failed", "nsfw", "expired", "quota"] as const;
export type UploadRejectReason = (typeof UPLOAD_REJECT_REASONS)[number];

/** Phase 3 signs listing photos only; the document schema knows the other purposes (§5). */
export const UPLOAD_PURPOSES = ["listing"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** WebP variants published under `listings/{listingId}/{photoId}-{variant}.webp` (D6); zod-free module for the browser. */
export { LEGACY_PHOTO_VARIANTS, PHOTO_VARIANTS, PHOTO_VARIANT_SPECS, type PhotoVariant } from "./photo-variants";

export const MEDIA_API = {
  sign: "/api/uploads/sign",
  /** GET status, DELETE. */
  upload: (id: string) => `/api/uploads/${id}`,
  complete: (id: string) => `/api/uploads/${id}/complete`,
} as const;

/** Upload (= photo) ids: URL- and object-key-safe, 8 to 40 alphanumerics. */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9]{8,40}$/;
export const uploadIdSchema = z.string().regex(UPLOAD_ID_PATTERN);

/** A photo as stored on the listing and returned once `ready`; `hash` = dHash hex (near-duplicates). */
export const listingPhotoSchema = z
  .object({
    id: uploadIdSchema,
    w: z.number().int().min(1).max(MAX_CLIENT_EDGE_PX * 4),
    h: z.number().int().min(1).max(MAX_CLIENT_EDGE_PX * 4),
    blurhash: z.string().min(6).max(120),
    hash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    /** Variants stored for it (set by the pipeline); absent on photos from before `m`: LEGACY_PHOTO_VARIANTS. */
    variants: z.array(z.enum(PHOTO_VARIANTS)).min(1).max(PHOTO_VARIANTS.length).optional(),
  })
  .strict();
export type ListingPhoto = z.infer<typeof listingPhotoSchema>;

export const signUploadSchema = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    /** The draft the photo belongs to. */
    targetId: z.string().regex(LISTING_ID_PATTERN),
    declaredSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    declaredType: z.enum(UPLOAD_DECLARED_TYPES),
  })
  .strict();
export type SignUploadInput = z.infer<typeof signUploadSchema>;

/** Answers. */
export interface SignUploadResponse {
  uploadId: string;
  /** Presigned PUT URL (cross-origin: no cookie, no CSRF header). */
  url: string;
  method: "PUT";
  headers: { "Content-Type": UploadDeclaredType };
  /** ISO 8601. */
  expiresAt: string;
}

export type UploadStatusResponse =
  | { status: "processing" }
  | { status: "ready"; photo: ListingPhoto }
  | { status: "rejected"; rejectReason: UploadRejectReason };
