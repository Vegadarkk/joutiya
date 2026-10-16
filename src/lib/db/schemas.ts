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
import { MAX_UPLOAD_BYTES, PHOTO_VARIANTS, UPLOAD_DECLARED_TYPES, UPLOAD_REJECT_REASONS, UPLOAD_STATUSES, listingPhotoSchema, uploadIdSchema } from "@/lib/contracts/media";
import { ROLES } from "@/lib/firebase/claims";
import { SAVED_SEARCH_ALERTS, SAVED_SEARCH_NAME_MAX } from "@/lib/contracts/search";
import { storedSearchParamsSchema } from "@/lib/search/params";

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
    reporter: z.object({ recent: z.array(z.boolean()).max(10), total: z.number().int().min(0), abusiveUntil: ts.optional() }).strict(),
    /** Sign-in providers linked to the account ("password", "google.com"). */
    providers: z.array(z.enum(["password", "google.com"])).max(2),
    closedAt: ts.optional(),
    purgeAt: ts.optional(),
    identityPurgeAt: ts.optional(),
  })
  .strict();
export type UserPrivateDoc = z.infer<typeof userPrivateSchema>;

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
export const PAUSED_REASONS = ["owner", "quota"] as const;

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
    hiddenBy: z.object({ reportId: z.string().min(1).max(128), signal: z.enum(["trusted", "multi", "auto", "authority"]), at: ts }).strict().optional(),
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
    /** Expiry or removal + listingPurgeMonths; blocked while `legalHold` is not empty. */
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
    /** Listing id for photos. */
    targetId: z.string().min(1).max(128),
    declaredSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    declaredType: z.enum(UPLOAD_DECLARED_TYPES),
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
      .object({ status: z.enum(["open", "upheld", "reversed"]), openedAt: ts, closedAt: ts.optional(), reviewer: z.string().max(128).optional(), note: z.string().max(2000).optional() })
      .strict()
      .optional(),
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

export const COLLECTIONS = {
  users: "users",
  userPrivate: "private",
  userPrivateDoc: "account",
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
} as const;
