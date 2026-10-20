import { z } from "@/lib/zod";
import { CONDITIONS } from "@/config/categories";
import { LOCALES } from "@/config/site";
import {
  DESCRIPTION_MAX,
  LISTING_STATUSES,
  MODERATION_FLAGS,
  MODERATION_STATES,
  PRICE_MAX,
  SENSITIVE_DECLARATION_KINDS,
  TITLE_MAX,
  citySlugSchema,
  listingAttributesSchema,
  listingIdSchema,
  regionCodeSchema,
  slugIdSchema,
} from "@/lib/contracts/listings";
import { MAX_UPLOAD_BYTES, PHOTO_VARIANTS, UPLOAD_DOC_DECLARED_TYPES, UPLOAD_REJECT_REASONS, UPLOAD_STATUSES, listingPhotoSchema, uploadIdSchema } from "@/lib/contracts/media";
import { ROLES } from "@/lib/firebase/claims";
import { SAVED_SEARCH_ALERTS, SAVED_SEARCH_NAME_MAX } from "@/lib/contracts/search";
import { storedSearchParamsSchema } from "@/lib/search/params";
import { MESSAGE_RISK_FLAGS, MESSAGE_TEXT_MAX } from "@/lib/contracts/messaging";
import { REPORT_PRIORITIES, REPORT_REASON_IDS, REPORT_TARGET_TYPES } from "@/config/report-reasons";
import type { LedgerReason } from "@/lib/payments/wallet";

// The enums shared with the browser are defined in the client-safe contracts (this module is
// server-only through claims.ts) and re-exported here so the repositories have one import.
export { CONDITIONS, LISTING_STATUSES, MODERATION_FLAGS, MODERATION_STATES, UPLOAD_REJECT_REASONS, UPLOAD_STATUSES };
export type { Condition } from "@/config/categories";
export type { ListingStatus, ModerationFlag, ModerationState } from "@/lib/contracts/listings";
export type { UploadRejectReason, UploadStatus } from "@/lib/contracts/media";

// Firestore documents (architecture §5), one Zod schema per collection written in phase 2.
// `.strict()` everywhere: no unknown field reaches Firestore. Timestamps are stored as Firestore
// Timestamps; the schemas accept Date for construction and validate the shape only.

const ts = z.date();
const uid = z.string().min(1).max(128);

export const localeSchema = z.enum(LOCALES);

/** 10 random characters from an unambiguous alphabet: /profil/{publicId}. */
export const publicIdSchema = z.string().regex(/^[a-hj-km-np-z2-9]{10}$/);

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  // Letters of any script, digits, spaces and a few separators: no URLs, no control characters.
  .regex(/^[\p{L}\p{M}\p{N} .'’-]+$/u);

export const userStatusSchema = z.enum(["active", "restricted", "suspended", "banned", "closed"]);

/** users/{uid}: public profile, rendered by the server. */
export const userSchema = z
  .object({
    publicId: publicIdSchema,
    displayName: displayNameSchema,
    avatarKey: z.string().max(200).optional(),
    type: z.enum(["individual", "pro"]),
    /** The account's shop, set by the Pro application (phase 7); `type` and the claims turn pro at the KYBC verification. */
    proId: z.string().max(64).optional(),
    regionCode: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
    citySlug: z.string().max(64).optional(),
    badges: z.object({ emailVerified: z.boolean(), phoneVerified: z.boolean(), proCertified: z.boolean() }).strict(),
    stats: z
      .object({ activeListings: z.number().int().min(0), responseRate: z.number().min(0).max(1), medianReplyMin: z.number().min(0), ratingAvg: z.number().min(0).max(5).optional(), ratingCount: z.number().int().min(0) })
      .strict(),
    status: userStatusSchema,
    /** "pending" until the e-mail is verified and the role claim set; purge-unactivated deletes pending accounts after 24 h. */
    activation: z.enum(["pending", "done"]),
    locale: localeSchema,
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type UserDoc = z.infer<typeof userSchema>;

export const consentSchema = z.object({ version: z.string().min(1).max(20), at: ts }).strict();

/** users/{uid}/private/account: never exposed to the client. */
export const userPrivateSchema = z
  .object({
    email: z.string().email().max(254),
    /** HMAC of the normalized e-mail (Gmail dots, +tag): limits and duplicates. */
    emailNormHash: z.string().min(16).max(64),
    phoneE164: z.string().regex(/^\+212[5-7]\d{8}$/).optional(),
    phoneVerifiedAt: ts.optional(),
    legalName: z.string().max(120).optional(),
    consents: z
      .object({
        cgu: consentSchema,
        /** Art. 44 loi 09-08: express consent to data transfers outside Morocco. */
        transfers: consentSchema,
        marketing: z.boolean(),
      })
      .strict(),
    strikes: z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), lastAt: ts.optional(), suspendedUntil: ts.optional() }).strict(),
    reporter: z
      .object({
        recent: z.array(z.boolean()).max(10),
        total: z.number().int().min(0),
        abusiveUntil: ts.optional(),
        /** Dates of reports dismissed as manifestly unfounded (art. 23 DSA, design D15), newest last. */
        manifest: z.array(ts).max(10).optional(),
        /** Prior warning of art. 23 sent. */
        warnedAt: ts.optional(),
      })
      .strict(),
    /** E-mail preferences (phase 5, D21): the grouped new-messages mail, on by default. */
    notifications: z.object({ messagesEmail: z.boolean() }).strict().optional(),
    /** Purge suspended while not empty ("report:{id}", "appeal:{id}", "authority:{id}"). */
    legalHold: z.array(z.string().min(1).max(64)).max(50).optional(),
    /** Sign-in providers linked to the account ("password", "google.com"). */
    providers: z.array(z.enum(["password", "google.com"])).max(2),
    closedAt: ts.optional(),
    purgeAt: ts.optional(),
    identityPurgeAt: ts.optional(),
  })
  .strict();
export type UserPrivateDoc = z.infer<typeof userPrivateSchema>;

/**
 * users/{uid}/private/identity (L7, D26): what outlives a closed account's purge (its purgeAt, 1 year)
 * until the account's identityPurgeAt (5 years, AF §7), stored here as `purgeAt` so one query on
 * `private` serves both documents: the civil identity when collected, and for a banned account the
 * e-mail HMAC that keeps the address from signing up again (its emailIndex entry stays).
 */
export const closedIdentitySchema = z
  .object({
    closedAt: ts,
    /** The account's identityPurgeAt (closure + 5 years). */
    purgeAt: ts,
    legalName: z.string().max(120).optional(),
    /** Banned account only: the emailIndex key kept as the ban's block on a new sign-up. */
    emailNormHash: z.string().min(16).max(64).optional(),
    banned: z.boolean(),
    legalHold: z.array(z.string().min(1).max(64)).max(50),
  })
  .strict();
export type ClosedIdentityDoc = z.infer<typeof closedIdentitySchema>;

/** emailIndex/{emailNormHash}: one account per normalized e-mail, enforced in a transaction. */
export const emailIndexSchema = z.object({ uid, createdAt: ts }).strict();
export type EmailIndexDoc = z.infer<typeof emailIndexSchema>;

/** connectionLogs/{id}: IP in clear (décret 2021-1362), admin-only under a requisition, purged after 1 year. */
export const connectionLogSchema = z
  .object({
    uid,
    event: z.enum(["signup", "login", "google_login", "google_signup", "staff_login", "password_reset", "password_change", "logout"]),
    ip: z.string().max(45),
    userAgent: z.string().max(200).optional(),
    at: ts,
    purgeAt: ts,
  })
  .strict();
export type ConnectionLogDoc = z.infer<typeof connectionLogSchema>;

/** auditLogs/{id}: append-only journal of staff and system actions (§5, 5 years). */
export const auditLogSchema = z
  .object({
    actorUid: z.string().max(128),
    actorRole: z.enum([...ROLES, "system"]),
    action: z.string().min(1).max(64),
    target: z.object({ type: z.string().min(1).max(32), id: z.string().min(1).max(128) }).strict(),
    automated: z.boolean(),
    reason: z.string().max(500).optional(),
    ipHash: z.string().max(64).optional(),
    at: ts,
    /** at + 5 years (phase 5); older entries have none and are kept. */
    purgeAt: ts.optional(),
  })
  .strict();
export type AuditLogDoc = z.infer<typeof auditLogSchema>;

/** mailSuppressions/{emailHash}: no non-transactional mail to these addresses (webhook of the ESP). */
export const mailSuppressionSchema = z
  .object({ reason: z.enum(["bounce", "complaint"]), provider: z.string().max(20), at: ts })
  .strict();
export type MailSuppressionDoc = z.infer<typeof mailSuppressionSchema>;

// ---- Phase 3: listings and media (architecture §5, design §1).

export const SELLER_TYPES = ["individual", "pro"] as const;
export const SORT_SOURCES = ["publish", "renew", "bump"] as const;
/** "moderation": paused for the length of an account suspension, resumed when it is lifted (phase 5, D14). */
export const PAUSED_REASONS = ["owner", "quota", "moderation"] as const;

/** City (later district) centroid, rounded (~1 km): never the seller's address. */
export const geoPointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

export const listingLocationSchema = z
  .object({ regionCode: regionCodeSchema, citySlug: citySlugSchema, district: z.string().min(1).max(64).optional(), geo: geoPointSchema })
  .strict();
export type ListingLocation = z.infer<typeof listingLocationSchema>;

export const moderationSchema = z
  .object({
    state: z.enum(MODERATION_STATES),
    /** Risk score 0-100 (§7 step 4). */
    score: z.number().min(0).max(100),
    flags: z.array(z.enum(MODERATION_FLAGS)).max(MODERATION_FLAGS.length),
    /** Russmedia: the advertiser declares being the person concerned, or holding explicit consent. */
    sensitiveDeclaration: z.object({ kind: z.enum(SENSITIVE_DECLARATION_KINDS), at: ts }).strict().optional(),
    openReports: z.number().int().min(0),
    /** Hidden by a report's strong signal (D11) or by a staff `restrict_visibility` decision (D13, `signal: "decision"`, reportId = the decision id when no report). */
    hiddenBy: z.object({ reportId: z.string().min(1).max(128), signal: z.enum(["trusted", "multi", "auto", "authority", "decision"]), at: ts }).strict().optional(),
    lastDecisionId: z.string().max(128).optional(),
    reviewedBy: z.string().max(128).optional(),
    reviewedAt: ts.optional(),
    ai: z
      .object({ decisionId: z.string().min(1).max(128), action: z.enum(["approve", "hold", "reject", "escalate"]), confidence: z.number().min(0).max(1), applied: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type ListingModeration = z.infer<typeof moderationSchema>;

/**
 * listings/{listingId}: §5 `Listing` plus `slugId`; the id is the document id. A draft (D2) is the
 * same document with `status: "draft"`: the fields the wizard fills step by step (category, texts,
 * location, slug) are optional or empty until publish, which `publishedListingSchema` requires.
 * `attributes` is validated by `criteriaSchema(subcategoryId)` at publish, stored as a map.
 */
export const listingSchema = z
  .object({
    ownerUid: uid,
    proId: z.string().max(64).optional(),
    sellerType: z.enum(SELLER_TYPES),
    /** Denormalized: the seller is always displayed (art. 6(3) DSA). */
    sellerName: displayNameSchema,
    sellerPublicId: publicIdSchema,
    status: z.enum(LISTING_STATUSES),
    pausedReason: z.enum(PAUSED_REASONS).optional(),
    /** `{slug}-{id}` of the canonical URL, set at publish (D1). */
    slugId: slugIdSchema.optional(),
    title: z.string().max(TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX),
    categoryId: z.string().min(1).max(40).optional(),
    subcategoryId: z.string().min(1).max(40).optional(),
    attributes: listingAttributesSchema,
    condition: z.enum(CONDITIONS).optional(),
    /** Integer MAD; null = "à discuter" (D4). */
    price: z.number().int().min(0).max(PRICE_MAX).nullable(),
    priceNegotiable: z.boolean(),
    isDonation: z.boolean(),
    location: listingLocationSchema.optional(),
    /** Order = display order; <= quotas.photosPerListing. */
    photos: z.array(listingPhotoSchema).max(50),
    /** The number is never here; `showPhone` requires `badges.phoneVerified` at publish. */
    contact: z.object({ messaging: z.literal(true), showPhone: z.boolean(), whatsapp: z.boolean() }).strict(),
    boosts: z.object({ bumpedAt: ts.optional(), featuredUntil: ts.optional(), dailyBumpUntil: ts.optional(), highlightUntil: ts.optional() }).strict(),
    sortAt: ts,
    sortSource: z.enum(SORT_SOURCES),
    moderation: moderationSchema,
    /** Moderated, no open report, not hidden. */
    adsEligible: z.boolean(),
    publishedAt: ts.optional(),
    /** publishedAt + listingTtlDays. */
    expiresAt: ts.optional(),
    /** Expiry, sale or removal + listingPurgeMonths, or a draft's last edit + 30 days; blocked while `legalHold` is not empty. */
    purgeAt: ts.optional(),
    legalHold: z.array(z.string().min(1).max(64)).max(50),
    createdAt: ts,
    updatedAt: ts,
    /** Optimistic lock and indexing order. */
    version: z.number().int().min(0),
  })
  .strict();
export type ListingDoc = z.infer<typeof listingSchema>;

/** A listing once published: what a draft may leave empty becomes required. */
export const publishedListingSchema = listingSchema.extend({
  slugId: slugIdSchema,
  categoryId: z.string().min(1).max(40),
  subcategoryId: z.string().min(1).max(40),
  location: listingLocationSchema,
  publishedAt: ts,
  expiresAt: ts,
});
export type PublishedListingDoc = z.infer<typeof publishedListingSchema>;

/** listingStats/{listingId}: nightly flush of the Valkey counters; never touches the listing. */
export const listingStatsSchema = z
  .object({
    views: z.number().int().min(0),
    favorites: z.number().int().min(0),
    contacts: z.number().int().min(0),
    phoneReveals: z.number().int().min(0),
    flushedAt: ts,
  })
  .strict();
export type ListingStatsDoc = z.infer<typeof listingStatsSchema>;

/** Every purpose of §5; phase 3 signs `listing` only (contracts/media.ts). */
export const UPLOAD_DOC_PURPOSES = ["listing", "kyb", "avatar", "pro_logo"] as const;
export const UPLOAD_BUCKETS = ["media", "private"] as const;

/** uploads/{id}: id = photo id; written by the API (sign) and the pipeline (worker or inline). */
export const uploadSchema = z
  .object({
    ownerUid: uid,
    purpose: z.enum(UPLOAD_DOC_PURPOSES),
    /** Listing id for photos; the applicant's uid for KYBC pieces (phase 7). */
    targetId: z.string().min(1).max(128),
    declaredSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    declaredType: z.enum(UPLOAD_DOC_DECLARED_TYPES),
    status: z.enum(UPLOAD_STATUSES),
    quarantineKey: z.string().min(1).max(200),
    /**
     * `listings/{listingId}/{photoId}` once ready (variants add `-l.webp` / `-s.webp`);
     * `removed/listings/{listingId}/{photoId}` once purge-quarantine moved a removed listing's photos.
     */
    finalKey: z.string().min(1).max(200).optional(),
    /** Where the variants are: `media` (public), or `private` for a removed listing's photos (moved there, kept until its purge). */
    bucket: z.enum(UPLOAD_BUCKETS),
    /** Real size from the HEAD on the quarantine object; once ready, the bytes of the variants (R2 storage gauge). */
    size: z.number().int().min(0).optional(),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    blurhash: z.string().min(6).max(120).optional(),
    /** dHash, 16 hex characters (near-duplicate photos). */
    hash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    /** Local models: nsfw score in [0, 1], number of faces found. */
    checks: z.object({ nsfw: z.number().min(0).max(1).optional(), faces: z.number().int().min(0).optional() }).strict(),
    variants: z.array(z.enum(PHOTO_VARIANTS)).max(PHOTO_VARIANTS.length).optional(),
    rejectReason: z.enum(UPLOAD_REJECT_REASONS).optional(),
    /**
     * Deleted by its owner under a legal hold once ready: `rejected`, but its variants stay as
     * evidence until the document purge, so the R2 storage gauge still counts its `size`.
     */
    heldObjects: z.literal(true).optional(),
    /** 7 days (retention-purge). */
    purgeAt: ts,
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type UploadDoc = z.infer<typeof uploadSchema>;

/** searchOutbox/{listingId}: written in the listing's transaction; consumed in phase 4. */
export const searchOutboxSchema = z.object({ op: z.enum(["upsert", "delete"]), version: z.number().int().min(0), enqueuedAt: ts }).strict();
export type SearchOutboxDoc = z.infer<typeof searchOutboxSchema>;

export const CONTENT_OPS = ["listing.create", "listing.update", "listing.publish", "listing.remove", "upload.create"] as const;

/** contentOps/{id}: who published what from which IP (LCEN, IP in clear), purged after 1 year. */
export const contentOpSchema = z
  .object({
    uid,
    op: z.enum(CONTENT_OPS),
    /** "listings/{id}" or "uploads/{id}". */
    contentRef: z.string().min(1).max(200),
    ip: z.string().max(45),
    at: ts,
    purgeAt: ts,
  })
  .strict();
export type ContentOpDoc = z.infer<typeof contentOpSchema>;

/** revealLogs/{id}: phone reveals (number scraping detection), purged after 90 days. */
export const revealLogSchema = z
  .object({
    viewerUid: uid,
    listingId: listingIdSchema,
    ipPrefixHash: z.string().min(1).max(64),
    deviceHash: z.string().min(1).max(64),
    at: ts,
    purgeAt: ts,
  })
  .strict();
export type RevealLogDoc = z.infer<typeof revealLogSchema>;

export const MODERATION_ACTIONS = ["remove", "restrict_visibility", "demote", "suspend_account", "ban", "warn", "restore", "no_action"] as const;

/** moderationDecisions/{id}: statement of reasons (art. 17 DSA), kept 5 years. */
export const moderationDecisionSchema = z
  .object({
    target: z.object({ type: z.string().min(1).max(32), id: z.string().min(1).max(128) }).strict(),
    affectedUid: uid,
    action: z.enum(MODERATION_ACTIONS),
    durationDays: z.number().int().min(1).max(3650).optional(),
    facts: z.string().max(2000),
    origin: z.enum(["notice", "own_initiative", "authority_order"]),
    automation: z.object({ detection: z.boolean(), decision: z.boolean() }).strict(),
    /** e.g. { type: "terms", ref: "CGU §7.2" }. */
    ground: z.object({ type: z.enum(["illegal", "terms"]), ref: z.string().max(64), explanation: z.string().max(2000) }).strict(),
    reportIds: z.array(z.string().min(1).max(128)).max(100),
    templateId: z.string().min(1).max(64),
    /** Staff uid, or "system" for automated decisions. */
    decidedBy: z.string().min(1).max(128),
    notifiedAt: ts.optional(),
    appeal: z
      .object({
        status: z.enum(["open", "upheld", "reversed"]),
        /** Who complains (art. 20: the affected user or the notifier, phase 5 D16). Absent on phase 3 records. */
        by: z.enum(["affected", "reporter"]).optional(),
        /** A notifier's appeal: the report it comes from (the outcome mail goes to its reporter). */
        reportId: z.string().max(128).optional(),
        text: z.string().max(2000).optional(),
        openedAt: ts,
        /** openedAt + 14 days. */
        slaDueAt: ts.optional(),
        closedAt: ts.optional(),
        reviewer: z.string().max(128).optional(),
        /** Reviewed by the admin who took the decision (owner decision, audit D1a-05; audited `appeal.self_review`). Moderators never. */
        selfReview: z.boolean().optional(),
        note: z.string().max(2000).optional(),
        /** The decision that reversed this one. */
        outcomeDecisionId: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    /** The agent's proposal this decision confirmed, edited or rejected (phase 5, D13). */
    aiDecisionId: z.string().max(128).optional(),
    /** Decision reversed on appeal by this one / that this one reverses. */
    supersededBy: z.string().max(128).optional(),
    supersedes: z.string().max(128).optional(),
    /** Notification + 6 months. */
    appealDeadline: ts,
    createdAt: ts,
    purgeAt: ts,
  })
  .strict();
export type ModerationDecisionDoc = z.infer<typeof moderationDecisionSchema>;

/** Upload id as stored on `photos[].id` (re-exported for the repositories). */
export { uploadIdSchema, listingIdSchema };

// ---- Phase 4: favorites and saved searches (architecture §5 "Autres collections").

const searchPhotoSchema = z.object({ id: z.string().min(1).max(64), w: z.number().int().min(1), h: z.number().int().min(1), blurhash: z.string().max(100) }).strict();

/** What a favorite shows once its listing is gone (sold, expired, removed): the card at the time it was saved. */
export const favoriteSnapshotSchema = z
  .object({
    slugId: slugIdSchema,
    title: z.string().max(TITLE_MAX),
    subcategoryId: z.string().max(40).nullable(),
    price: z.number().int().min(0).max(PRICE_MAX).nullable(),
    priceNegotiable: z.boolean(),
    isDonation: z.boolean(),
    citySlug: z.string().max(64).nullable(),
    photo: searchPhotoSchema.nullable(),
    photoCount: z.number().int().min(0),
    sellerType: z.enum(["individual", "pro"]),
  })
  .strict();
export type FavoriteSnapshot = z.infer<typeof favoriteSnapshotSchema>;

/** users/{uid}/favorites/{listingId}. */
export const favoriteSchema = z.object({ createdAt: ts, listingSnapshot: favoriteSnapshotSchema }).strict();
export type FavoriteDoc = z.infer<typeof favoriteSchema>;

/** users/{uid}/savedSearches/{id}: 10 at most; alerts are daily e-mails, never instant (no reverse search). */
export const savedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(SAVED_SEARCH_NAME_MAX),
    params: storedSearchParamsSchema,
    alert: z.enum(SAVED_SEARCH_ALERTS),
    /** sortAt (epoch ms) of the newest listing already sent by the alert; listings after it are new. */
    lastNotifiedSortAt: z.number().int().min(0),
    lastAlertAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type SavedSearchDoc = z.infer<typeof savedSearchSchema>;

// ---- Phase 5: messaging, reports, decisions, AI (architecture §5, design phase-5/DESIGN.md §1).

const hold = z.array(z.string().min(1).max(64)).max(50);
const participantsSchema = z.tuple([uid, uid]);

/** conversations/{cid}: one per (listing, buyer); cid derived on the server (D1). Served to participants by the API (D2). */
export const conversationSchema = z
  .object({
    listingId: listingIdSchema,
    listingSlugId: slugIdSchema,
    sellerUid: uid,
    /** Pro listing: the shop's shared inbox (phase 7). */
    sellerProId: z.string().max(64).optional(),
    buyerUid: uid,
    /** [buyerUid, sellerUid]: the inbox query filters on it. */
    participants: participantsSchema,
    sellerName: z.string().max(80),
    sellerPublicId: publicIdSchema,
    buyerName: z.string().max(80),
    buyerPublicId: publicIdSchema,
    listingSnapshot: z
      .object({
        title: z.string().max(TITLE_MAX),
        price: z.number().int().min(0).max(PRICE_MAX).nullable(),
        isDonation: z.boolean(),
        photo: z.object({ id: z.string().min(1).max(64), blurhash: z.string().max(100) }).strict().nullable(),
      })
      .strict(),
    lastMessage: z.object({ preview: z.string().max(140), senderUid: uid, at: ts, flagged: z.boolean() }).strict(),
    /** Unread count per participant uid. */
    unread: z.record(uid, z.number().int().min(0)),
    blockedBy: z.array(uid).max(2),
    archivedBy: z.array(uid).max(2),
    /** "Delete for me": hidden from that participant's inbox until a new message arrives. */
    hiddenFor: z.array(uid).max(2),
    /** frozen: dispute or authority request, nobody can write (D17). */
    status: z.enum(["open", "frozen"]),
    /** Participants who closed their account (L7, D26): the other one still reads, nobody writes. */
    accountClosed: z.array(uid).max(2).optional(),
    messageCount: z.number().int().min(0),
    createdAt: ts,
    updatedAt: ts,
    /** Last activity + 12 months (AF §7 retention). */
    purgeAt: ts,
    legalHold: hold,
  })
  .strict();
export type ConversationDoc = z.infer<typeof conversationSchema>;

/** conversations/{cid}/messages/{mid}: participants duplicated from the conversation (AF §6). */
export const messageSchema = z
  .object({
    senderUid: uid,
    participants: participantsSchema,
    sellerProId: z.string().max(64).optional(),
    type: z.enum(["text", "system"]),
    /** URLs masked (D5); `⟦hidden⟧` once hidden by moderation. */
    text: z.string().max(MESSAGE_TEXT_MAX + 200),
    risk: z.object({ flags: z.array(z.enum(MESSAGE_RISK_FLAGS)).min(1).max(4), warned: z.boolean() }).strict().optional(),
    hidden: z.boolean().optional(),
    createdAt: ts,
    readAt: ts.optional(),
  })
  .strict();
export type MessageDoc = z.infer<typeof messageSchema>;

/** conversations/{cid}/evidence/{mid}: server-only original of a masked or hidden message (rules deny). */
export const messageEvidenceSchema = z
  .object({ text: z.string().max(MESSAGE_TEXT_MAX), flags: z.array(z.enum(MESSAGE_RISK_FLAGS)).max(4), reason: z.enum(["masked", "hidden"]), createdAt: ts })
  .strict();
export type MessageEvidenceDoc = z.infer<typeof messageEvidenceSchema>;

/** userBlocks/{uid}: accounts this user blocked (D6). */
export const userBlocksSchema = z.object({ uids: z.array(uid).max(500), updatedAt: ts }).strict();
export type UserBlocksDoc = z.infer<typeof userBlocksSchema>;

export const REPORT_STATUSES = ["open", "in_review", "actioned", "dismissed"] as const;
export const STRONG_SIGNALS = ["trusted", "multi", "auto", "authority"] as const;
/** `listing.moderation.hiddenBy.signal`: a strong signal, or "decision" for a staff restriction (D13). */
export const HIDE_SIGNALS = [...STRONG_SIGNALS, "decision"] as const;
export type HideSignal = (typeof HIDE_SIGNALS)[number];

/** reports/{id}: notice of art. 16 DSA (D10), kept 5 years. */
export const reportSchema = z
  .object({
    target: z
      .object({
        type: z.enum(REPORT_TARGET_TYPES),
        /** listingId, uid, `{cid}/{mid}`, or proId. */
        id: z.string().min(1).max(128),
        /** Owner of the reported content (the person a decision would affect). */
        ownerUid: uid,
        /** Profile publicId of a user target, for the back-office links. */
        publicId: publicIdSchema.optional(),
        /** Listing of a reported message's conversation, for context. */
        listingId: listingIdSchema.optional(),
      })
      .strict(),
    reasonId: z.enum(REPORT_REASON_IDS),
    priority: z.enum(REPORT_PRIORITIES),
    explanation: z.string().max(2000),
    goodFaith: z.literal(true),
    /** user: notice form; system: messaging repeat rule or the agent; authority: authority request. */
    source: z.enum(["user", "system", "authority"]),
    reporter: z
      .object({
        uid: uid.optional(),
        name: z.string().max(80).optional(),
        email: z.string().email().max(254).optional(),
        locale: localeSchema,
        ipPrefixHash: z.string().max(64),
        deviceHash: z.string().max(64),
        trusted: z.boolean(),
      })
      .strict(),
    strongSignal: z.enum(STRONG_SIGNALS).optional(),
    /** The target was hidden because of this report. */
    hidden: z.boolean(),
    status: z.enum(REPORT_STATUSES),
    outcome: z.enum(["founded", "unfounded"]).optional(),
    manifestlyUnfounded: z.boolean().optional(),
    assignee: uid.optional(),
    slaDueAt: ts,
    decisionId: z.string().max(128).optional(),
    aiDecisionId: z.string().max(128).optional(),
    authorityRequestId: z.string().max(128).optional(),
    ackSentAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
    closedAt: ts.optional(),
    /** createdAt + 5 years. */
    purgeAt: ts,
  })
  .strict();
export type ReportDoc = z.infer<typeof reportSchema>;

export const AI_TASKS = ["listing_screen", "report_triage", "appeal_review"] as const;
export const AI_PROVIDERS = ["anthropic", "workers-ai", "openai", "rules"] as const;
export const AI_ACTIONS = ["approve", "hold", "reject", "escalate"] as const;
/** What a triage or appeal proposal says of the report or appeal it is about (src/lib/ai/types.ts). */
export const AI_VERDICTS = ["founded", "unfounded", "needs_human", "unclear"] as const;
export const AI_APPLIED = ["auto", "pending", "confirmed", "edited", "rejected"] as const;

/** aiDecisions/{id}: the agent's proposal (Z4); never a sanction by itself. */
export const aiDecisionSchema = z
  .object({
    task: z.enum(AI_TASKS),
    target: z.object({ type: z.enum(["listing", "report", "decision"]), id: z.string().min(1).max(128) }).strict(),
    provider: z.enum(AI_PROVIDERS),
    model: z.string().max(80),
    promptVersion: z.string().max(40),
    output: z
      .object({
        action: z.enum(AI_ACTIONS),
        /** report_triage and appeal_review only: the back office reads it instead of `action` (audit D1b-10). */
        verdict: z.enum(AI_VERDICTS).optional(),
        policy: z.string().max(64),
        severity: z.enum([...REPORT_PRIORITIES, "none"]),
        confidence: z.number().min(0).max(1),
        rationale: z.string().max(1000),
        /** Draft statement of reasons (art. 17) for the seller, French. */
        userMessage: z.string().max(1500).optional(),
        /** Suggested decision template (report triage, appeal review). */
        templateId: z.string().max(64).optional(),
      })
      .strict(),
    applied: z.enum(AI_APPLIED),
    reviewedBy: uid.optional(),
    decisionId: z.string().max(128).optional(),
    costMicroUsd: z.number().int().min(0),
    /** sha256 of the masked input: the same input is not sent twice. */
    inputHash: z.string().max(64),
    error: z.string().max(200).optional(),
    createdAt: ts,
    /** + 12 months; the decision's purgeAt (5 years) when it grounds a decision. */
    purgeAt: ts,
    legalHold: hold,
  })
  .strict();
export type AiDecisionDoc = z.infer<typeof aiDecisionSchema>;

/** authorityRequests/{id}: requisitions and orders register (admin only, D17). */
export const authorityRequestSchema = z
  .object({
    authority: z.string().min(2).max(200),
    country: z.enum(["FR", "MA", "EU", "other"]),
    legalBasis: z.string().min(2).max(500),
    kind: z.enum(["removal_order", "data_request", "preservation", "other"]),
    /** "listing:{id}", "user:{uid}", "conversation:{cid}". */
    scope: z.array(z.string().min(3).max(160)).min(1).max(50),
    identityCheck: z.object({ method: z.string().min(2).max(300), at: ts, by: uid }).strict(),
    receivedAt: ts,
    dueAt: ts.optional(),
    status: z.enum(["open", "answered", "closed"]),
    response: z.string().max(4000).optional(),
    respondedAt: ts.optional(),
    /** Hold ids set on the scoped documents. */
    holds: z.array(z.string().min(1).max(160)).max(50),
    reportIds: z.array(z.string().max(128)).max(50),
    createdBy: uid,
    createdAt: ts,
    updatedAt: ts,
    closedAt: ts.optional(),
    /** closedAt + 5 years; far future while open. */
    purgeAt: ts,
  })
  .strict();
export type AuthorityRequestDoc = z.infer<typeof authorityRequestSchema>;

/** suspensions/{uid}: active suspension, deleted by lift-suspensions when it ends (D14). */
export const suspensionSchema = z.object({ until: ts, decisionId: z.string().min(1).max(128), createdAt: ts }).strict();
export type SuspensionDoc = z.infer<typeof suspensionSchema>;

// ---- Phase 7: credits wallet (design §3, §5) --------------------------------------------------

const creditAmount = z.number().int().min(-1_000_000).max(1_000_000);

/**
 * wallets/{accountId} (`uid`, or `pro_{proId}` for a shop): purchased balance (may go negative
 * after a refund, then `frozen`), the plan's monthly credits and À la Une allowance, each valid
 * until its `resetsAt` (not cumulative: the next grant replaces them, an ended period voids them).
 */
export const walletSchema = z
  .object({
    balance: creditAmount,
    frozen: z.boolean(),
    planCredits: z.number().int().min(0).max(100_000),
    planCreditsResetsAt: ts.optional(),
    allowances: z.object({ featured: z.number().int().min(0).max(1_000), resetsAt: ts.optional() }).strict(),
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type WalletDoc = z.infer<typeof walletSchema>;

export const LEDGER_REASONS = ["purchase", "option", "plan_grant", "refund", "refund_reversed", "admin_adjust"] as const satisfies readonly LedgerReason[];

/**
 * wallets/{accountId}/ledger/{entryId}: append-only. Ids are deterministic (idempotency):
 * `option_{listingId}_{requestId}`, `purchase_{storeTransactionId}`, `refund_{...}`, `grant_{...}`.
 */
export const ledgerEntrySchema = z
  .object({
    reason: z.enum(LEDGER_REASONS),
    delta: creditAmount,
    paidPart: creditAmount,
    bonusPart: creditAmount,
    planCreditsDelta: creditAmount,
    featuredAllowanceDelta: creditAmount,
    balanceAfter: creditAmount,
    /** Price of the option or pack in credits (what the buyer agreed to). */
    price: z.number().int().min(0).max(1_000_000).optional(),
    refs: z
      .object({
        listingId: listingIdSchema.optional(),
        optionId: z.string().min(1).max(32).optional(),
        requestId: z.string().min(1).max(64).optional(),
        orderId: z.string().min(1).max(128).optional(),
        subscriptionId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    /** Country of taxation of a purchase (lot 3). */
    taxJurisdiction: z.enum(["MA", "EU"]).optional(),
    /** Both purchase boxes ticked (CGV + withdrawal, immediate execution), with the text version. */
    consent: z.object({ version: z.string().min(1).max(20), at: ts }).strict().optional(),
    /** Who acted: the buyer, or "system" for a grant or a webhook. */
    actorUid: uid,
    at: ts,
  })
  .strict();
export type LedgerEntryDoc = z.infer<typeof ledgerEntrySchema>;

// ---- Phase 7: credit packs (design §3, §6) ------------------------------------------------------

/**
 * billingAccounts/{accountId} (same id as the wallet): who pays, and the RevenueCat app user id
 * (UUID v4, never the uid: RevenueCat and the payment link only see this value).
 */
export const billingAccountSchema = z
  .object({
    kind: z.enum(["personal", "shop"]),
    ownerUid: uid,
    proId: z.string().min(1).max(64).optional(),
    rcAppUserId: z.uuid(),
    /** The last pack checkout opened, with the CGV consent given before the payment page. */
    lastCheckout: z
      .object({ packId: z.string().min(1).max(40), consentVersion: z.string().min(1).max(20), at: ts })
      .strict()
      .optional(),
    /** Stripe Customer of the shop (Pro subscriptions), created at its first plan checkout. */
    stripeCustomerId: z.string().regex(/^cus_[A-Za-z0-9]{1,100}$/).optional(),
    /** The last plan checkout opened, with the CGV and auto-renewal consent. */
    lastPlanCheckout: z
      .object({ plan: z.enum(["essentiel", "business"]), interval: z.enum(["monthly", "yearly"]), consentVersion: z.string().min(1).max(20), at: ts })
      .strict()
      .optional(),
    /** A refund left the wallet negative: the account waits on an admin. */
    flaggedAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type BillingAccountDoc = z.infer<typeof billingAccountSchema>;

export const ORDER_STATUSES = ["paid", "refunded"] as const;
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const rcEnvironment = z.enum(["SANDBOX", "PRODUCTION"]);

/**
 * orders/{storeTransactionId}: one paid pack, created with its ledger credit in the same
 * transaction (the natural key makes a replayed event credit once). Kept 10 years (accounting).
 */
export const orderSchema = z
  .object({
    kind: z.literal("pack"),
    accountId: uid,
    packId: z.string().min(1).max(40),
    productId: z.string().min(1).max(100),
    quantity: z.number().int().min(1).max(10),
    /** Credits granted (paid part and bonus, already multiplied by the quantity). */
    credits: z.object({ paid: z.number().int().min(0).max(1_000_000), bonus: z.number().int().min(0).max(1_000_000) }).strict(),
    currency: currencyCode,
    /** Price charged in `currency`, minor units, from the event. */
    amountMinor: z.number().int().min(0).max(1_000_000_000).optional(),
    status: z.enum(ORDER_STATUSES),
    environment: rcEnvironment,
    store: z.string().min(1).max(32),
    taxJurisdiction: z.enum(["MA", "EU"]),
    /** Country of the buyer as RevenueCat saw it (DGI register indicators, design §3). */
    locationEvidence: z.object({ countryCode: countryCode.optional() }).strict(),
    consent: z.object({ version: z.string().min(1).max(20), at: ts }).strict().optional(),
    eventId: z.string().min(1).max(128),
    refundEventId: z.string().min(1).max(128).optional(),
    purchasedAt: ts,
    refundedAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type OrderDoc = z.infer<typeof orderSchema>;

export const BILLING_EVENT_STATUSES = ["received", "processed", "ignored", "failed"] as const;

/**
 * billingEvents/{source}_{eventId}: every authenticated webhook delivery (RevenueCat or Stripe),
 * deduplicated by the event id. Holds only what processing needs; the worker re-reads the purchase
 * or the subscription from RevenueCat before writing anything.
 */
export const BILLING_EVENT_SOURCES = ["revenuecat", "stripe"] as const;
export type BillingEventSource = (typeof BILLING_EVENT_SOURCES)[number];

export const billingEventSchema = z
  .object({
    source: z.enum(BILLING_EVENT_SOURCES),
    eventId: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    environment: rcEnvironment,
    /** RevenueCat's customer (always on a RevenueCat event; a Stripe event's metadata when present). */
    appUserId: z.string().min(1).max(1_500).optional(),
    /** Stripe: the event's Customer, Subscription and object (session, subscription, invoice). */
    customerId: z.string().min(1).max(255).optional(),
    subscriptionId: z.string().min(1).max(255).optional(),
    objectId: z.string().min(1).max(255).optional(),
    /** RevenueCat: a pack's purchase or refund, or a Pro plan's change (synced). */
    kind: z.enum(["pack", "subscription"]).optional(),
    productId: z.string().min(1).max(100).optional(),
    transactionId: z.string().min(1).max(255).optional(),
    cancelReason: z.string().min(1).max(64).optional(),
    store: z.string().min(1).max(32).optional(),
    currency: currencyCode.optional(),
    amountMinor: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
    countryCode: countryCode.optional(),
    quantity: z.number().int().min(1).max(10).optional(),
    status: z.enum(BILLING_EVENT_STATUSES),
    /** What processing did (`credited`, `refunded`, `duplicate`, `unknown_product`, ...). */
    outcome: z.string().min(1).max(64).optional(),
    attempts: z.number().int().min(0).max(1_000),
    lastError: z.string().max(500).optional(),
    occurredAt: ts.optional(),
    receivedAt: ts,
    processedAt: ts.optional(),
  })
  .strict();
export type BillingEventDoc = z.infer<typeof billingEventSchema>;

export const SUBSCRIPTION_STATUSES = ["active", "grace", "billing_issue", "cancelled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * subscriptions/{accountId} (`pro_{proId}`): the shop's plan as RevenueCat last showed it (source of
 * truth; Stripe bills). `cancelled` = paid until `periodEnd`, will not renew. Written with the Pro
 * lifecycle transition and the month's grant in one transaction.
 */
export const subscriptionSchema = z
  .object({
    plan: z.enum(["essentiel", "business"]),
    interval: z.enum(["monthly", "yearly"]),
    status: z.enum(SUBSCRIPTION_STATUSES),
    /** RevenueCat subscription id and the store's (`sub_...` for Stripe). */
    rcSubscriptionId: z.string().min(1).max(255),
    storeSubscriptionId: z.string().min(1).max(255),
    store: z.string().min(1).max(32),
    environment: rcEnvironment,
    periodStart: ts,
    periodEnd: ts.optional(),
    willRenew: z.boolean(),
    /** Start of the last month granted (plan credits and À la Une allowance). */
    grantedSlotStart: ts.optional(),
    lastEventId: z.string().min(1).max(128).optional(),
    syncedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type SubscriptionDoc = z.infer<typeof subscriptionSchema>;

export const COLLECTIONS = {
  users: "users",
  userPrivate: "private",
  userPrivateDoc: "account",
  /** users/{uid}/private/identity: what a closed account keeps after its purge (L7). */
  userIdentityDoc: "identity",
  emailIndex: "emailIndex",
  connectionLogs: "connectionLogs",
  auditLogs: "auditLogs",
  mailSuppressions: "mailSuppressions",
  /** staff/{uid}: back-office roster (src/lib/db/repositories/staff.ts). */
  staff: "staff",
  // Phase 3
  listings: "listings",
  listingStats: "listingStats",
  uploads: "uploads",
  searchOutbox: "searchOutbox",
  contentOps: "contentOps",
  revealLogs: "revealLogs",
  moderationDecisions: "moderationDecisions",
  /** system/backup (cursor state of backup-firestore), free-form documents. */
  system: "system",
  // Phase 4 (subcollections of users/{uid})
  favorites: "favorites",
  savedSearches: "savedSearches",
  // Phase 7
  proProfiles: "proProfiles",
  wallets: "wallets",
  /** wallets/{accountId}/ledger/{entryId} */
  ledger: "ledger",
  billingAccounts: "billingAccounts",
  orders: "orders",
  billingEvents: "billingEvents",
  subscriptions: "subscriptions",
  // Phase 5
  conversations: "conversations",
  /** conversations/{cid}/messages/{mid} */
  messages: "messages",
  /** conversations/{cid}/evidence/{mid} (server only) */
  evidence: "evidence",
  userBlocks: "userBlocks",
  reports: "reports",
  aiDecisions: "aiDecisions",
  authorityRequests: "authorityRequests",
  suspensions: "suspensions",
} as const;
