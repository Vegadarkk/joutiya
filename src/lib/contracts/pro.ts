import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { citySlugSchema, regionCodeSchema } from "@/lib/contracts/listings";
import { KYBC_DECLARED_TYPES, MAX_UPLOAD_BYTES, type KybcDeclaredType } from "@/lib/contracts/media";
import { KYBC_MAX_PIECES, KYBC_MIN_PIECES, proLegalSchema } from "@/lib/pro/kybc";
import { PRO_DESCRIPTION_MAX, PRO_NAME_MAX } from "@/lib/pro/profile-schema";

// Pro application (phase 7 design §4): POST /api/pro/apply. Client-safe contract shared by the
// wizard and the route. The KYBC pieces are uploads (purpose `kyb`) the applicant signed before.

export const proApplySchema = z
  .object({
    name: z.string().trim().min(2).max(PRO_NAME_MAX),
    description: z.string().trim().max(PRO_DESCRIPTION_MAX).default(""),
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    legal: proLegalSchema,
    uploadIds: z.array(z.string().min(1).max(64)).min(KYBC_MIN_PIECES).max(KYBC_MAX_PIECES),
    /** Compliance commitment (§7 art. 30-inspired traceability): must be ticked. */
    complianceCommitment: z.literal(true),
    turnstileToken: turnstileTokenSchema,
  })
  .strict();
export type ProApplyInput = z.infer<typeof proApplySchema>;

export interface ProApplyResponse {
  proId: string;
  status: "pending_verification";
}

// Back office (admin.joutiya.ma/pros): the KYBC queue and the moderator's decision. `submittedAt`
// pins the application the moderator reviewed: a resubmission meanwhile answers 409.

export const PRO_REGISTRY_SOURCES = ["ompic", "directinfo"] as const;
export const PRO_REJECT_REASON_MIN = 10;
export const PRO_REJECT_REASON_MAX = 1000;

export const proDecisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("verify"),
      /** Register the moderator checked the identifiers against. */
      registrySource: z.enum(PRO_REGISTRY_SOURCES),
      submittedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal("reject"),
      /** Sent to the applicant as written: motivated and specific. */
      reason: z.string().trim().min(PRO_REJECT_REASON_MIN).max(PRO_REJECT_REASON_MAX),
      submittedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type ProDecisionInput = z.infer<typeof proDecisionSchema>;

export interface ProQueueItem {
  proId: string;
  name: string;
  legalForm: string;
  citySlug: string;
  ice: string;
  iceFormatOk: boolean;
  pieces: number;
  owner: { displayName: string; publicId: string } | null;
  /** ISO. */
  submittedAt: string;
}

export interface ProQueueResponse {
  items: ProQueueItem[];
  hasMore: boolean;
}

export interface ProReviewPiece {
  id: string;
  status: string;
  declaredType: string;
  size: number | null;
}

export interface ProReview {
  proId: string;
  name: string;
  slug: string;
  description: string;
  regionCode: string;
  citySlug: string;
  legal: Record<string, string>;
  kybc: { status: string; iceFormatOk: boolean; submittedAt: string | null; rejectReason: string | null; registrySource: string | null };
  lifecycle: string;
  plan: string;
  planSource: string;
  owner: { uid: string; displayName: string; publicId: string; status: string; emailVerified: boolean; phoneVerified: boolean; createdAt: string } | null;
  pieces: ProReviewPiece[];
}

export interface ProDecisionResponse {
  proId: string;
  lifecycle: string;
  /** Listings of the owner retagged as Pro (verify only). */
  retagged: number;
}

// KYBC pieces (design §4): POST /api/pro/kybc/uploads signs a presigned PUT to the quarantine
// bucket; POST /api/pro/kybc/uploads/{id}/complete checks the bytes and moves the piece to the
// private bucket. The piece's upload id then goes in the application's `uploadIds`.

export const PRO_API = {
  apply: "/api/pro/apply",
  kybcSign: "/api/pro/kybc/uploads",
  kybcComplete: (id: string) => `/api/pro/kybc/uploads/${id}/complete`,
} as const;

export const kybcSignSchema = z
  .object({
    declaredSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    declaredType: z.enum(KYBC_DECLARED_TYPES),
  })
  .strict();
export type KybcSignInput = z.infer<typeof kybcSignSchema>;

export interface KybcSignResponse {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: { "Content-Type": KybcDeclaredType };
  /** ISO 8601. */
  expiresAt: string;
}

export type KybcCompleteResponse = { status: "ready"; uploadId: string } | { status: "rejected"; uploadId: string; reason: "too_large" | "bad_type" | "expired" };
