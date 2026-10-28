import { z } from "@/lib/zod";
import { CONDITIONS, categoryById, subcategoryById } from "@/config/categories";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { MAX_PHOTOS_PRO, uploadIdSchema, type ListingPhoto, type UploadRejectReason, type UploadStatus } from "@/lib/contracts/media";
import { LISTING_ID_PATTERN, SLUG_ID_MAX, SLUG_ID_PATTERN } from "@/lib/listings/ids";
import { DAY_PATTERN, RENTAL_PERIODS_MAX, type RentalPeriod } from "@/lib/listings/rental-availability";

// Shared client/server contracts of the listings API (phase 3, design §3). Imported by the wizard
// (react-hook-form + zodResolver) and by the route handlers: one validation, same messages.
// Client-safe: no env, no db. Objects are strict: unknown fields are refused (§6 injection).

export const TITLE_MIN = 5;
export const TITLE_MAX = 70;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 4000;
/** Integer MAD. */
export const PRICE_MAX = 100_000_000;
/** Drafts per user (D2). */
export const MAX_DRAFTS = 5;
export const DISTRICT_MAX = 64;

/** Listing lifecycle (§5). */
export const LISTING_STATUSES = ["draft", "pending_review", "published", "paused", "sold", "expired", "rejected", "removed", "purged"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const MODERATION_STATES = ["auto_ok", "needs_review", "auto_rejected", "human_ok", "human_rejected"] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

/** Soft signals of the pre-moderation (§7, D8); hard blockers come back as field issues instead. */
export const MODERATION_FLAGS = [
  "prohibited_kw",
  "prohibited_soft",
  "sensitive_text",
  "third_party_phone",
  "face",
  "nsfw_review",
  "price_outlier",
  "dup_text",
  "dup_photo",
  "new_account",
  "volume",
  "restricted_category",
  "credit_ad",
  "rental_review",
] as const;
export type ModerationFlag = (typeof MODERATION_FLAGS)[number];

export const SENSITIVE_DECLARATION_KINDS = ["self", "explicit_consent"] as const;
export type SensitiveDeclarationKind = (typeof SENSITIVE_DECLARATION_KINDS)[number];

/** Wizard steps, in order (D3): `/deposer/{id}/{step}`; the result screen is `/deposer/{id}/termine`. */
export const WIZARD_STEPS = ["categorie", "criteres", "titre", "description", "photos", "prix", "lieu", "contact", "apercu"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const WIZARD_DONE = "termine";

/** Tabs of "Mes annonces" (`GET /api/listings/mine?status=`). */
export const OWNER_LIST_BUCKETS = ["drafts", "active", "pending", "ended"] as const;
export type OwnerListBucket = (typeof OWNER_LIST_BUCKETS)[number];

export { LISTING_API } from "./endpoints";

export const listingIdSchema = z.string().regex(LISTING_ID_PATTERN);
export const slugIdSchema = z.string().max(SLUG_ID_MAX).regex(SLUG_ID_PATTERN);
export const regionCodeSchema = z.string().regex(/^(0[1-9]|1[0-2])$/);
export const citySlugSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** Kebab-case ids of the category tree; existence is checked against the config below. */
const treeIdSchema = z.string().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const titleSchema = z.string().trim().min(TITLE_MIN).max(TITLE_MAX);
export const descriptionSchema = z.string().trim().min(DESCRIPTION_MIN).max(DESCRIPTION_MAX);
export const priceSchema = z.number().int().min(0).max(PRICE_MAX);
export const conditionSchema = z.enum(CONDITIONS);

/** Shape of `attributes`; the values are checked in depth by `criteriaSchema(subcategoryId)`. */
export const attributeValueSchema = z.union([z.string().max(80), z.number(), z.boolean(), z.array(z.string().max(80)).max(50)]);
export const listingAttributesSchema = z.record(z.string().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), attributeValueSchema);
export type ListingAttributes = z.infer<typeof listingAttributesSchema>;

export const listingLocationInputSchema = z
  .object({
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    district: z.string().trim().min(1).max(DISTRICT_MAX).optional(),
  })
  .strict();
export type ListingLocationInput = z.infer<typeof listingLocationInputSchema>;

export const listingContactInputSchema = z
  .object({
    /** Requires `badges.phoneVerified` at publish time (server check). */
    showPhone: z.boolean(),
    whatsapp: z.boolean(),
  })
  .strict();

function checkTree(data: { categoryId?: string | undefined; subcategoryId?: string | undefined }, ctx: z.RefinementCtx): void {
  if (data.categoryId !== undefined && !categoryById(data.categoryId)) {
    ctx.addIssue({ code: "custom", path: ["categoryId"], message: "unknown category" });
  }
  if (data.subcategoryId === undefined) return;
  const subcategory = subcategoryById(data.subcategoryId);
  if (!subcategory) {
    ctx.addIssue({ code: "custom", path: ["subcategoryId"], message: "unknown subcategory" });
  } else if (data.categoryId !== undefined && subcategory.categoryId !== data.categoryId) {
    ctx.addIssue({ code: "custom", path: ["subcategoryId"], message: "subcategory outside the category" });
  }
}

/** `POST /api/listings`: the category may come later (step 1 of the wizard). */
export const createListingSchema = z
  .object({
    categoryId: treeIdSchema.optional(),
    subcategoryId: treeIdSchema.optional(),
  })
  .strict()
  .superRefine(checkTree);
export type CreateListingInput = z.infer<typeof createListingSchema>;

/**
 * `PATCH /api/listings/{id}`: every field optional, the object strict. Text bounds apply to what is
 * sent (the client skips invalid fields instead of saving them); publish readiness is the server's.
 */
export const listingPatchSchema = z
  .object({
    categoryId: treeIdSchema.optional(),
    subcategoryId: treeIdSchema.optional(),
    // Drafts keep half-typed text (D2 autosave); the minimums are checked at publish and on live
    // listings by assessReadiness.
    title: z.string().trim().max(TITLE_MAX).optional(),
    description: z.string().trim().max(DESCRIPTION_MAX).optional(),
    attributes: listingAttributesSchema.optional(),
    condition: conditionSchema.nullable().optional(),
    /** null = "à discuter" (allowed only with `isDonation` or a `priceOptional` subcategory). */
    price: priceSchema.nullable().optional(),
    priceNegotiable: z.boolean().optional(),
    isDonation: z.boolean().optional(),
    location: listingLocationInputSchema.optional(),
    /** Ordered upload ids; the server keeps only those that are `ready` and owned. */
    photos: z.array(uploadIdSchema).max(MAX_PHOTOS_PRO).optional(),
    contact: listingContactInputSchema.optional(),
    sensitiveDeclaration: z.object({ kind: z.enum(SENSITIVE_DECLARATION_KINDS) }).strict().nullable().optional(),
  })
  .strict()
  .superRefine(checkTree);
export type ListingPatch = z.infer<typeof listingPatchSchema>;

export const publishListingSchema = z
  .object({
    /** Required when the IP limit escalates (`listing.create.ip`). */
    turnstileToken: turnstileTokenSchema.optional(),
    acceptRules: z.literal(true),
    /** Adults-only subcategory: the seller attests a decorative craft object sold to adults only. */
    adultsOnlyAttestation: z.literal(true).optional(),
    /** Real estate: the advertiser attests its declared data and bears sole responsibility for them. */
    realEstateAttestation: z.literal(true).optional(),
    /** Car rental: the agency attests its licence, the vehicle's registration and insurance, and its declarations. */
    rentalAttestation: z.literal(true).optional(),
  })
  .strict();
export type PublishListingInput = z.infer<typeof publishListingSchema>;

/** A blocked period of a car rental (rental pack §3): Morocco days, bounds included. */
export const rentalPeriodSchema = z.object({ from: z.string().regex(DAY_PATTERN), to: z.string().regex(DAY_PATTERN) }).strict();

/**
 * PUT /api/listings/{id}/availability: every blocked period (replaces them), merged and trimmed
 * server-side. `since` is the `updatedAt` the calendar was opened with (null: never set): another
 * save meanwhile answers 409 `conflict`. Unchanged periods confirm the availability ("Tout est à jour").
 */
export const rentalAvailabilityInputSchema = z
  .object({ unavailable: z.array(rentalPeriodSchema).max(RENTAL_PERIODS_MAX * 2), since: z.string().datetime().nullable() })
  .strict();
export type RentalAvailabilityInput = z.infer<typeof rentalAvailabilityInputSchema>;

/** Vehicles of a fleet planning (rental pack §3) and the most one save may change. */
export const FLEET_MAX = 200;

/**
 * PUT /api/pro/fleet: the fleet planning's changes, each like a calendar save (its own `since`
 * lock). The vehicles left as they are sent unchanged confirm their availability ("Tout est à jour").
 */
export const fleetSaveSchema = z
  .object({ changes: z.array(rentalAvailabilityInputSchema.extend({ id: listingIdSchema })).min(1).max(FLEET_MAX) })
  .strict();
export type FleetSaveInput = z.infer<typeof fleetSaveSchema>;

/** Answers. Dates are ISO 8601 strings. */

/** A car rental's declared availability; `updatedAt` null until the agency first saves it. */
export interface RentalAvailability {
  unavailable: RentalPeriod[];
  updatedAt: string | null;
}
export type RentalAvailabilityResponse = { rental: RentalAvailability };
/** GET /api/pro/fleet: the agency's car rentals on offer (published, paused, in review), by title. */
export interface FleetResponse {
  vehicles: OwnerListingSummary[];
  /** More than FLEET_MAX rentals: the planning shows the first ones. */
  truncated: boolean;
}
/** Each change's outcome, in the order sent: its new availability, or why it was not saved. */
export interface FleetSaveResponse {
  results: ({ id: string; rental: RentalAvailability } | { id: string; error: "conflict" | "not_found" | "invalid_body" | "failed" })[];
}
export interface FieldIssue {
  /** Dotted path in the listing ("title", "attributes.year", "photos"). */
  path: string;
  /** Stable code translated client-side (`Listing.validation.<code>`). */
  code: string;
  message?: string;
}

export interface OwnerPhoto {
  id: string;
  status: UploadStatus;
  w?: number;
  h?: number;
  blurhash?: string;
  rejectReason?: UploadRejectReason;
  /** Faces found on a ready photo (absent: none or unchecked): the wizard proposes a crop. */
  faces?: number;
}

export interface OwnerListingSummary {
  id: string;
  slugId: string | null;
  status: ListingStatus;
  title: string;
  price: number | null;
  isDonation: boolean;
  categoryId: string | null;
  subcategoryId: string | null;
  citySlug: string | null;
  thumb: ListingPhoto | null;
  photoCount: number;
  moderation: { state: ModerationState; flags: ModerationFlag[] };
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  expiresAt: string | null;
  /** Expired before purge, or published with less than 7 days left (D16). */
  canRenew: boolean;
  /** Car rentals only: the blocked periods the availability calendar edits. */
  rental?: RentalAvailability;
}

export interface OwnerListing {
  id: string;
  slugId: string | null;
  status: ListingStatus;
  /** Pro-only criteria (stock reference) are offered to Pro listings only. */
  sellerType: "individual" | "pro";
  pausedReason: "owner" | "quota" | "moderation" | null;
  categoryId: string | null;
  subcategoryId: string | null;
  title: string;
  description: string;
  attributes: ListingAttributes;
  condition: (typeof CONDITIONS)[number] | null;
  price: number | null;
  priceNegotiable: boolean;
  isDonation: boolean;
  location: ListingLocationInput | null;
  /** Wizard order, processing status merged from `uploads`. */
  photos: OwnerPhoto[];
  contact: { showPhone: boolean; whatsapp: boolean };
  sensitiveDeclaration: { kind: SensitiveDeclarationKind; at: string } | null;
  moderation: { state: ModerationState; flags: ModerationFlag[] };
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  expiresAt: string | null;
}

export type CreateListingResponse = { id: string };
/** `salesOpen`: paid options can be bought (config/flags.salesEnabled, phase 7). */
export type OwnerListingsResponse = { listings: OwnerListingSummary[]; salesOpen: boolean };
export type ListingResponse = { listing: OwnerListing };
export type PublishListingResponse = {
  status: Extract<ListingStatus, "published" | "pending_review" | "rejected">;
  slugId?: string;
  /** Localized path of the public page when published. */
  url?: string;
  flags: ModerationFlag[];
  /** Non-empty only in the 422 `invalid_listing` answer. */
  blockers: FieldIssue[];
};
export type PhoneRevealResponse = { phone: { e164: string; display: string; whatsappUrl?: string } };
