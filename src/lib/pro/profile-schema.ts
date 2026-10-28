import { z } from "@/lib/zod";
import { PRO_PLANS, listingQuotasSchema } from "@/config/pricing";
import { PAYMENT_URL_MAX } from "@/config/seller-payments";
import { sellerInfoInputSchema } from "@/lib/contracts/seller-payment";
import { citySlugSchema, regionCodeSchema } from "@/lib/contracts/listings";
import { KYBC_MAX_PIECES, KYBC_STATUSES, proLegalSchema } from "./kybc";
import { PLAN_SOURCES, PRO_STATES } from "./lifecycle";

// proProfiles/{proId} (architecture §5 `ProProfile`, phase 7 design §3). No server import: the
// repository (src/lib/db/repositories/pro-profiles.ts) and the unit tests share this schema.
// The registration IP is in connectionLogs, never here. Written by the server only.

export const PRO_ID_PATTERN = /^[a-hj-km-np-z2-9]{8}$/;
export const proIdSchema = z.string().regex(PRO_ID_PATTERN);

export const PRO_NAME_MAX = 80;
export const PRO_DESCRIPTION_MAX = 2000;
export const PRO_SLUG_MAX = 60;

const uid = z.string().min(1).max(128);
const ts = z.date();
/** Moroccan mobile in E.164, as users/{uid}/private/account.phoneE164 (src/lib/db/schemas.ts). */
const mobileE164 = z.string().regex(/^\+212[67]\d{8}$/);

/** Outcome of a moderator's call to the applicant's number (phase 7: the WhatsApp check is parked until Meta validates the app). */
export const PHONE_CHECK_OUTCOMES = ["verified", "unreachable", "mismatch"] as const;
export type PhoneCheckOutcome = (typeof PHONE_CHECK_OUTCOMES)[number];

const paymentUrl = z.url({ protocol: /^https$/ }).max(PAYMENT_URL_MAX);
const host = z.string().min(1).max(253);

/** The distance seller's information of law 31-08 (art. 29), shown on the storefront while the button is on. */
export const sellerInfoSchema = sellerInfoInputSchema;
export type SellerInfo = z.infer<typeof sellerInfoSchema>;

export const sellerPaymentSchema = z
  .object({
    /** Active link (its host must still be allowed when shown). */
    url: paymentUrl.optional(),
    /** A new link, active from `pendingFrom` + 24 h once its host is allowed. */
    pendingUrl: paymentUrl.optional(),
    pendingFrom: ts.optional(),
    /** Host of `pendingUrl`, kept for the admin queue (query by host). */
    pendingHost: host.optional(),
    /** `pendingHost` is not on the allowlist yet: listed for an admin's review. */
    hostReview: z.boolean().optional(),
    /** The last host an admin refused, with the reason shown to the owner. */
    hostRejected: z.object({ host, reason: z.string().min(1).max(500), at: ts }).strict().optional(),
    cashOnDelivery: z.boolean(),
    info: sellerInfoSchema.optional(),
    /** Cut by a moderator (report « Lien de paiement suspect »): nothing is shown until restored. */
    suspendedAt: ts.optional(),
    suspendedReason: z.string().min(1).max(500).optional(),
    updatedAt: ts,
  })
  .strict();
export type SellerPaymentDoc = z.infer<typeof sellerPaymentSchema>;

export const proProfileSchema = z
  .object({
    ownerUid: uid,
    /** `editor` seats arrive in V1.1 (§6); the MVP has the owner only. */
    members: z.record(uid, z.enum(["owner", "editor"])),
    name: z.string().trim().min(2).max(PRO_NAME_MAX),
    slug: z.string().min(1).max(PRO_SLUG_MAX).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().max(PRO_DESCRIPTION_MAX),
    logoKey: z.string().max(200).optional(),
    coverKey: z.string().max(200).optional(),
    /** Verified number, revealed under quota like an individual's (never in the HTML). */
    phonePublic: z.string().max(20).optional(),
    whatsapp: z.boolean(),
    website: z.url({ protocol: /^https$/ }).max(200).optional(),
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    legal: proLegalSchema,
    kybc: z
      .object({
        status: z.enum(KYBC_STATUSES),
        iceFormatOk: z.boolean(),
        registryCheck: z.object({ source: z.enum(["ompic", "directinfo", "odco"]), at: ts, by: uid }).strict().optional(),
        /** Pieces in the private bucket (uploads purpose `kyb`), purged 6 months after the relationship ends. */
        uploadIds: z.array(z.string().min(1).max(64)).max(KYBC_MAX_PIECES),
        complianceCommitmentAt: ts.optional(),
        /** Collection notice shown with the pieces when they were sent (`KYBC_NOTICE_VERSION`). */
        noticeVersion: z.string().max(20).optional(),
        /** Number to call, declared with the application while the account has no verified number; deleted once verified. */
        phoneToCheck: mobileE164.optional(),
        /** The moderator's last call (who, when, outcome, number); `verified` also set the account's badge. */
        phoneCheck: z.object({ at: ts, by: uid, outcome: z.enum(PHONE_CHECK_OUTCOMES), phone: mobileE164, note: z.string().max(200).optional() }).strict().optional(),
        submittedAt: ts.optional(),
        rejectReason: z.string().max(1000).optional(),
        decisionId: z.string().max(64).optional(),
      })
      .strict(),
    /** Badge « Certifié »: pieces checked in detail (Business). */
    certified: z.object({ at: ts, by: uid }).strict().optional(),
    lifecycle: z.enum(PRO_STATES),
    /** Copy of subscriptions/pro_{proId}, or the launch offer's plan. */
    plan: z.enum(PRO_PLANS),
    planSource: z.enum(PLAN_SOURCES),
    graceUntil: ts.optional(),
    downgradedAt: ts.optional(),
    suspendedFrom: z.enum(PRO_STATES).optional(),
    launchOfferNoticeSentAt: ts.optional(),
    /** End of the Pass Boutique (`planSource: "pass"`); kept after the end as the last pass bought. */
    passEndsAt: ts.optional(),
    /** Date of the last notice mailed before the end of the pass (the next one is due from it). */
    passNoticeSentAt: ts.optional(),
    /** « Payer chez le vendeur » (design phase-7/boutique-temporaire.md §2); absent until the owner sets it. */
    sellerPayment: sellerPaymentSchema.optional(),
    /** Derived from config/pricing for `plan`. */
    quotas: listingQuotasSchema,
    /**
     * The claims grant or the listings retag of a verification failed at this date: the nightly
     * pro-effects-sync (or the moderator's verify again) reruns them; absent once they are done.
     */
    effectsPendingSince: ts.optional(),
    /** Rejected application: the profile (identifiers) and its pieces go at this date (6 months, retention-purge). */
    purgeAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type ProProfileDoc = z.infer<typeof proProfileSchema>;
