import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { citySlugSchema, regionCodeSchema } from "@/lib/contracts/listings";
import { KYBC_DECLARED_TYPES, MAX_UPLOAD_BYTES, uploadIdSchema, type KybcDeclaredType } from "@/lib/contracts/media";
import { KYBC_MAX_PIECES, KYBC_MIN_PIECES, proLegalSchema } from "@/lib/pro/kybc";
import {
  AGENCY_FEE_SCHEDULE_MAX,
  PHONE_CHECK_OUTCOMES,
  PRO_DESCRIPTION_MAX,
  PRO_NAME_MAX,
  PRO_SECTORS,
  RENTAL_CHECK_REASON_MAX,
  rentalAgencySchema,
  type PhoneCheckOutcome,
  type ProSector,
  type RentalAgency,
  type RentalCheckIssue,
  type RentalCheckStatus,
} from "@/lib/pro/profile-schema";

// Pro application (phase 7 design §4): POST /api/pro/apply. Client-safe contract shared by the
// wizard and the route. The KYBC pieces are uploads (purpose `kyb`) the applicant signed before.

export const proApplySchema = z
  .object({
    name: z.string().trim().min(2).max(PRO_NAME_MAX),
    description: z.string().trim().max(PRO_DESCRIPTION_MAX).default(""),
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    legal: proLegalSchema,
    /**
     * Mobile a moderator calls during the review, required while the account has no verified
     * number and the WhatsApp check is unavailable (`ProMeResponse.phoneVerification` "call").
     */
    phone: z.string().trim().max(32).optional(),
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

export const PRO_REGISTRY_SOURCES = ["ompic", "directinfo", "odco"] as const;
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

/**
 * POST /api/admin/pros/{proId}/rental-check (decision 5): a moderator decides a car rental
 * agency's licence document the AI check left in doubt. `submittedAt` pins the document reviewed.
 */
export const RENTAL_CHECK_REASON_MIN = 10;
export const rentalCheckDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify"), submittedAt: z.iso.datetime({ offset: true }) }).strict(),
  z
    .object({
      action: z.literal("reject"),
      /** Shown to the agency as written. */
      reason: z.string().trim().min(RENTAL_CHECK_REASON_MIN).max(RENTAL_CHECK_REASON_MAX),
      submittedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type RentalCheckDecisionInput = z.infer<typeof rentalCheckDecisionSchema>;
export interface RentalCheckDecisionResponse {
  proId: string;
  status: RentalCheckStatus;
}

/** A licence document waiting for a moderator (admin.joutiya.ma/pros). */
export interface RentalCheckQueueItem {
  proId: string;
  name: string;
  agrementRef: string;
  issues: RentalCheckIssue[];
  /** ISO. */
  submittedAt: string;
}

/** The licence check as the back office shows it: the agency's view plus what Claude read. */
export interface RentalCheckReview extends RentalCheckView {
  uploadId: string;
  /** Reference the document is checked against (the settings' reference when it was sent). */
  agrementRef: string;
  issues: RentalCheckIssue[];
  /** What Claude read on the document; null when it did not run. */
  extracted: { companyName: string; ice: string; reference: string; decisionDate: string; signs: string[]; note: string } | null;
  piece: ProReviewPiece | null;
}

/**
 * POST /api/admin/pros/{proId}/phone: the moderator called the applicant's number during the
 * review (while the WhatsApp check is unavailable). `verified` marks the number verified on the
 * account, which the verify decision needs; the other outcomes are recorded and the application
 * waits. `phone` replaces the declared number when the applicant corrected it on the call.
 */
export const proPhoneCheckSchema = z
  .object({
    outcome: z.enum(PHONE_CHECK_OUTCOMES),
    phone: z.string().trim().max(32).optional(),
    /** For the next moderator; nothing about the applicant beyond the call itself. */
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export type ProPhoneCheckInput = z.infer<typeof proPhoneCheckSchema>;

export interface ProPhoneCheckResponse {
  proId: string;
  outcome: PhoneCheckOutcome;
  /** The account's badge after the check. */
  phoneVerified: boolean;
  /** The number was taken away from another account (told by e-mail), like the WhatsApp path. */
  transferred: boolean;
}

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
  kybc: {
    status: string;
    iceFormatOk: boolean;
    submittedAt: string | null;
    rejectReason: string | null;
    registrySource: string | null;
    /** The moderator's last call to the applicant's number (ISO `at`). */
    phoneCheck: { at: string; by: string; outcome: PhoneCheckOutcome; phone: string; note: string | null } | null;
  };
  lifecycle: string;
  plan: string;
  planSource: string;
  /** Verified, but the claims grant or the listings retag failed: verify again reruns them. */
  effectsPending: boolean;
  owner: {
    uid: string;
    displayName: string;
    publicId: string;
    status: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    /** E.164 the applicant declared for the moderator's call, while the account has no verified number. */
    phoneToCheck: string | null;
    createdAt: string;
  } | null;
  pieces: ProReviewPiece[];
  /** Car rental agency licence check (decision 5), null when the agency never sent a document. */
  rentalCheck: RentalCheckReview | null;
}

export interface ProDecisionResponse {
  proId: string;
  lifecycle: string;
  /** Listings of the owner retagged as Pro (verify only). */
  retagged: number;
  /** The claims grant or the retag failed after the commit: the nightly sync reruns them, or verify again. */
  effectsPending: boolean;
}

// KYBC pieces (design §4): POST /api/pro/kybc/uploads signs a presigned PUT to the quarantine
// bucket; POST /api/pro/kybc/uploads/{id}/complete checks the bytes and moves the piece to the
// private bucket; DELETE /api/pro/kybc/uploads/{id} removes a piece no pending application lists.
// The piece's upload id then goes in the application's `uploadIds`. The photo routes
// (/api/uploads/**) never see these uploads.

export const PRO_API = {
  apply: "/api/pro/apply",
  me: "/api/pro/me",
  agency: "/api/pro/me/agency",
  rental: "/api/pro/me/rental",
  rentalCheck: "/api/pro/me/rental/check",
  kybcSign: "/api/pro/kybc/uploads",
  kybcComplete: (id: string) => `/api/pro/kybc/uploads/${id}/complete`,
  kybcDelete: (id: string) => `/api/pro/kybc/uploads/${id}`,
} as const;

/** PUT /api/pro/me/agency (Agence pack design §3): the shop's sector and, for an agency, its fee schedule. */
export const proAgencySchema = z
  .object({
    sector: z.enum(PRO_SECTORS),
    feeSchedule: z.string().trim().max(AGENCY_FEE_SCHEDULE_MAX),
  })
  .strict();
export type ProAgencyInput = z.infer<typeof proAgencySchema>;
export type ProAgencyResponse = ProAgencyInput;

/** PUT /api/pro/me/rental (rental pack §5): the car rental agency's settings, replaced whole. */
export const proRentalSchema = rentalAgencySchema;
export type ProRentalInput = RentalAgency;
export type ProRentalResponse = { rental: RentalAgency };

/**
 * POST /api/pro/me/rental/check (decision 5): sends the licence decision, a KYBC piece signed with
 * `use: "agrement"` and completed, for the check against the reference in the settings.
 */
export const rentalCheckSubmitSchema = z.object({ uploadId: uploadIdSchema }).strict();
export type RentalCheckSubmitInput = z.infer<typeof rentalCheckSubmitSchema>;

/** The licence check as the agency sees it. */
export interface RentalCheckView {
  status: RentalCheckStatus;
  /** ISO. */
  submittedAt: string;
  /** ISO, once decided (by the AI check or a moderator). */
  checkedAt: string | null;
  method: "ai" | "staff" | null;
  /** The moderator's reason for a refusal. */
  reason: string | null;
}
export type RentalCheckResponse = { rentalCheck: RentalCheckView };

export const kybcSignSchema = z
  .object({
    declaredSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    declaredType: z.enum(KYBC_DECLARED_TYPES),
    /** "agrement": a car rental agency's licence decision (a publishing shop), else a piece of a Pro application. */
    use: z.enum(["application", "agrement"]).optional(),
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

/** Reasons a piece is refused: wrong bytes, over 10 MiB, a PDF with active content, or nothing received in time. */
export const KYBC_REJECT_REASONS = ["too_large", "bad_type", "active_content", "expired"] as const;
export type KybcRejectReason = (typeof KYBC_REJECT_REASONS)[number];

export type KybcCompleteResponse = { status: "ready"; uploadId: string } | { status: "rejected"; uploadId: string; reason: KybcRejectReason };

/** GET /api/pro/me: the signed-in account's shop (or application) and what it may do next. */
export interface ProMeResponse {
  signupOpen: boolean;
  salesOpen: boolean;
  /** How an unverified number gets verified: by WhatsApp before applying, or by a moderator's call during the review ("call": the form asks the number). */
  phoneVerification: "whatsapp" | "call";
  /** The launch offer a shop verified now receives (design D3), or null when none is open. */
  launchOffer: { noticeDays: number } | null;
  eligibility: { emailVerified: boolean; phoneVerified: boolean; accountActive: boolean };
  shop: ProSelfView | null;
}

export interface ProSelfView {
  proId: string;
  name: string;
  slug: string;
  description: string;
  regionCode: string;
  citySlug: string;
  legalForm: string;
  ice: string;
  lifecycle: string;
  plan: string;
  planSource: string;
  kybcStatus: string;
  rejectReason: string | null;
  /** ISO. */
  submittedAt: string | null;
  quotas: { activeListings: number | null; listingsPerDay: number | null; photosPerListing: number };
  activeListings: number;
  /** Launch offer in force for this shop (design D3); `endsAt` ISO or null while no end is announced. */
  launchOffer: { endsAt: string | null; noticeDays: number } | null;
  /** Public storefront path segment `{slug}-{proId}`, when the storefront is shown. */
  storefront: string | null;
  sector: ProSector;
  /** The agency's fee schedule ("" when none or not an agency). */
  feeSchedule: string;
  /** Car rental agency settings, null until saved (publishing a rental needs the licence reference). */
  rental: RentalAgency | null;
  /** Check of the licence decision, null until a document is sent (or after the reference changed). */
  rentalCheck: RentalCheckView | null;
}
