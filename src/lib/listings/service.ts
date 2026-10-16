import "server-only";
import { isDeepStrictEqual } from "node:util";
import { subcategoryById } from "@/config/categories";
import { listingLifetime, listingQuotas, withinQuota, type ListingQuotas, type Seller } from "@/config/pricing";
import { cityBySlug, cityName } from "@/config/regions";
import type { AuthContext } from "@/lib/auth/guards";
import { requireOwner } from "@/lib/auth/guards";
import type { Device } from "@/lib/auth/respond";
import { audit } from "@/lib/audit";
import { MAX_DRAFTS, type CreateListingInput, type FieldIssue, type ListingPatch, type ListingStatus, type ModerationFlag, type PublishListingResponse } from "@/lib/contracts/listings";
import { listingPhotoSchema, type ListingPhoto } from "@/lib/contracts/media";
import { listingContentRef, recordContentOp, recordContentOpTx } from "@/lib/db/repositories/content-ops";
import {
  ACTIVE_STATUSES,
  ActiveLimitError,
  DraftLimitError,
  ListingVersionError,
  applyPatch,
  countActive,
  countActiveTx,
  countDraftsTx,
  countPublishedSince,
  createListing,
  getListing,
  getListingTx,
  listOwnerListingsByStatus,
  updateListingTx,
  type ListingFieldPatch,
  type ListingRecord,
} from "@/lib/db/repositories/listings";
import { recordModerationDecisionTx, type ModerationDecisionInput } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { getUploads, updateUpload } from "@/lib/db/repositories/uploads";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { listingSchema, type ListingDoc, type ListingModeration } from "@/lib/db/schemas";
import { serverEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { ModerationStatement, TemplateData } from "@/lib/mail/types";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { escalateOnIp } from "./escalation";
import { buildSlugId, newListingId } from "./ids";
import { IllegalTransitionError, canRenew, canTransition, renew, renewForReview, transition, type Lifetime, type TransitionContext, type TransitionEffects, type TransitionResult } from "./lifecycle";
import { ownerListingView } from "./owner-view";
import { PUBLIC_STATES } from "./public";
import { assessReadiness } from "./readiness";
import { revalidateListingPaths } from "./revalidate";
import { screen, sellerFacts, type ScreeningResult } from "./screening";

// Listing service (design §4 service.ts): drafts, edits, publication, status changes. Every entry
// point takes the signed-in `AuthContext` (ownership answers 404, never 403) and the clear IP for
// contentOps (LCEN). Writes that change the status go through one Firestore transaction with the
// searchOutbox and contentOps entries; audit, revalidation and mails follow the commit.

export interface Actor {
  auth: AuthContext;
  /** Clear client IP (contentOps); "" when unknown. */
  ip: string;
}

export type OwnerAction = "pause" | "resume" | "sold" | "renew" | "remove";

/** Statuses the owner may still edit (sold, removed and purged listings are read-only). */
export const EDITABLE_STATUSES: readonly ListingStatus[] = ["draft", "pending_review", "published", "paused", "expired", "rejected"];
/**
 * Listings published before (live, paused, held or expired): an edit must stay publishable
 * (readiness), is re-screened and may fall back to pending_review. Drafts are screened at publish.
 */
const SCREENED_STATUSES: readonly ListingStatus[] = ["published", "paused", "pending_review", "expired"];
/** Fields whose change re-runs the pre-moderation (every free text, the district included). */
const SCREENED_FIELDS: readonly (keyof ListingDoc)[] = ["title", "description", "attributes", "categoryId", "subcategoryId", "price", "isDonation", "photos", "contact", "location"];
/** CGU reference quoted in the automated statements (design D8). */
const AUTOMATED_GROUND = "CGU §7 (contrôle avant publication)";
const DAY_MS = 24 * 60 * 60 * 1000;

interface SellerContext {
  user: UserRecord;
  seller: Seller;
  quotas: ListingQuotas;
}

async function sellerOf(auth: AuthContext): Promise<SellerContext> {
  const user = await getUserRecord(auth.user.uid);
  if (!user) throw new HttpError(403, "forbidden", "account record missing");
  // Phase 3 publishes individuals; a verified Pro without a plan has the `none` quotas (D5).
  const seller: Seller = user.type === "pro" || auth.user.claims.role === "pro" ? { type: "pro", plan: "none" } : { type: "individual" };
  return { user, seller, quotas: listingQuotas(seller) };
}

async function lifetime(): Promise<Lifetime> {
  return listingLifetime(await getLegalConfig());
}

async function ownedListing(actor: Actor, id: string): Promise<ListingRecord> {
  const listing = await getListing(id);
  if (!listing) throw notFound();
  requireOwner(actor.auth, listing);
  return listing;
}

const invalidListing = (blockers: FieldIssue[]) => new HttpError(422, "invalid_listing", undefined, { details: blockers });

/** The public page renders the listing (published, or with a banner): an edit revalidates it. */
const hasPublicPage = (status: ListingStatus) => (PUBLIC_STATES as readonly ListingStatus[]).includes(status);

/** Runs a lifecycle step; a transition the table forbids is a 409 conflict, never a 500. */
function step(compute: () => TransitionResult): TransitionResult {
  try {
    return compute();
  } catch (error) {
    if (error instanceof IllegalTransitionError) throw new HttpError(409, "conflict", error.message);
    throw error;
  }
}

/** `activeListings` quota (published + pending_review): 409 `listing_limit` when another listing would exceed it. */
async function assertWithinQuota(uid: string, quotas: ListingQuotas): Promise<void> {
  if (!withinQuota(quotas.activeListings, await countActive(uid))) throw new HttpError(409, "listing_limit");
}

// ---- Drafts ---------------------------------------------------------------------------------

export async function createDraft(actor: Actor, input: CreateListingInput, now = new Date()): Promise<{ id: string }> {
  const { user, seller } = await sellerOf(actor.auth);
  const { uid, claims } = actor.auth.user;
  const subcategory = input.subcategoryId ? subcategoryById(input.subcategoryId) : undefined;
  const id = newListingId();
  const doc: ListingDoc = listingSchema.parse({
    ownerUid: uid,
    ...(seller.type === "pro" && claims.proId ? { proId: claims.proId } : {}),
    sellerType: seller.type,
    sellerName: user.displayName,
    sellerPublicId: user.publicId,
    status: "draft",
    title: "",
    description: "",
    ...(subcategory ? { categoryId: subcategory.categoryId, subcategoryId: subcategory.id } : input.categoryId ? { categoryId: input.categoryId } : {}),
    attributes: {},
    price: null,
    priceNegotiable: false,
    isDonation: false,
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: now,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: false,
    legalHold: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  try {
    await createListing(id, doc, { maxDrafts: MAX_DRAFTS });
  } catch (error) {
    if (error instanceof DraftLimitError) throw new HttpError(409, "draft_limit");
    throw error;
  }
  if (actor.ip) await recordContentOp({ uid, op: "listing.create", contentRef: listingContentRef(id), ip: actor.ip, now });
  return { id };
}

// ---- Edits ----------------------------------------------------------------------------------

function invalidField(path: string, code: string): HttpError {
  return new HttpError(400, "invalid_body", undefined, { details: [{ path, code }] });
}

/** Turns a wizard patch into document fields (tree consistency, city centroid, photo order). */
async function fieldsOf(listing: ListingRecord, patch: ListingPatch, ctx: { uid: string; quotas: ListingQuotas; now: Date }): Promise<ListingFieldPatch> {
  const fields: ListingFieldPatch = {};
  if (patch.subcategoryId !== undefined) {
    const subcategory = subcategoryById(patch.subcategoryId);
    if (!subcategory) throw invalidField("subcategoryId", "unknown");
    fields.subcategoryId = subcategory.id;
    fields.categoryId = subcategory.categoryId;
    // Another subcategory: its criteria differ, the old attributes go unless new ones come along.
    if (subcategory.id !== listing.subcategoryId) fields.attributes = patch.attributes ?? {};
  } else if (patch.categoryId !== undefined) {
    fields.categoryId = patch.categoryId;
    if (listing.subcategoryId && subcategoryById(listing.subcategoryId)?.categoryId !== patch.categoryId) {
      fields.subcategoryId = null;
      fields.attributes = {};
    }
  }
  if (patch.attributes !== undefined) fields.attributes = patch.attributes;
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.description !== undefined) fields.description = patch.description;
  if (patch.condition !== undefined) fields.condition = patch.condition;
  if (patch.price !== undefined) fields.price = patch.price;
  if (patch.priceNegotiable !== undefined) fields.priceNegotiable = patch.priceNegotiable;
  if (patch.isDonation !== undefined) {
    fields.isDonation = patch.isDonation;
    if (patch.isDonation && patch.price === undefined) fields.price = null;
  }
  if (patch.location !== undefined) {
    const city = cityBySlug(patch.location.citySlug);
    if (!city) throw invalidField("location.citySlug", "unknown");
    if (city.regionCode !== patch.location.regionCode) throw invalidField("location.regionCode", "mismatch");
    // The listing never carries the seller's address: the city centroid stands for the position.
    fields.location = { regionCode: city.regionCode, citySlug: city.slug, ...(patch.location.district ? { district: patch.location.district } : {}), geo: { lat: city.lat, lng: city.lng } };
  }
  if (patch.contact !== undefined) fields.contact = { messaging: true, showPhone: patch.contact.showPhone, whatsapp: patch.contact.whatsapp };
  if (patch.sensitiveDeclaration !== undefined) {
    const { sensitiveDeclaration: declared, ...rest } = listing.moderation;
    // The same declaration again keeps its date: only a new kind is a new declaration.
    const kept = declared && declared.kind === patch.sensitiveDeclaration?.kind ? declared : undefined;
    fields.moderation = patch.sensitiveDeclaration ? { ...rest, sensitiveDeclaration: kept ?? { kind: patch.sensitiveDeclaration.kind, at: ctx.now } } : rest;
  }
  if (patch.photos !== undefined) {
    if (patch.photos.length > ctx.quotas.photosPerListing) throw new HttpError(409, "photo_limit");
    const attached = new Map(listing.photos.map((photo) => [photo.id, photo]));
    const fresh = patch.photos.filter((photoId) => !attached.has(photoId));
    const uploads = fresh.length > 0 ? await getUploads(fresh) : [];
    const ready = new Map(uploads.filter((upload) => upload.ownerUid === ctx.uid && upload.targetId === listing.id && upload.status === "ready").map((upload) => [upload.id, upload]));
    const photos = [];
    for (const photoId of new Set(patch.photos)) {
      const current = attached.get(photoId);
      if (current) {
        photos.push(current);
        continue;
      }
      const upload = ready.get(photoId);
      if (!upload) continue;
      const photo = listingPhotoSchema.safeParse({ id: upload.id, w: upload.width, h: upload.height, blurhash: upload.blurhash, ...(upload.hash ? { hash: upload.hash } : {}) });
      if (photo.success) photos.push(photo.data);
    }
    fields.photos = photos;
  }
  return fields;
}

/**
 * The fields of a save that change the stored listing. `null` deletes, so it changes only a field
 * that holds a value (`price: null` too: null is its value). Resent values drop out, so a screened
 * field is screened again only when it changes.
 */
function changedFields(listing: ListingRecord, fields: ListingFieldPatch): ListingFieldPatch {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const stored = (listing as unknown as Record<string, unknown>)[key];
    if (value === null ? stored === undefined || stored === null : isDeepStrictEqual(stored, value)) continue;
    changed[key] = value;
  }
  return changed as ListingFieldPatch;
}

/**
 * Photos a save dropped from the listing: their uploads are due now, so the hourly
 * purge-quarantine deletes them (it checks first that the listing does not hold them again, and
 * keeps them under a legal hold). A failure leaves them to their current purgeAt, never fails the save.
 */
async function releaseDroppedPhotos(listing: ListingRecord, photos: readonly ListingPhoto[], now: Date): Promise<void> {
  const kept = new Set(photos.map((photo) => photo.id));
  const dropped = listing.photos.filter((photo) => !kept.has(photo.id));
  await Promise.all(
    dropped.map(async (photo) => {
      try {
        await updateUpload(photo.id, { purgeAt: now }, now);
      } catch (error) {
        logger.warn({ listingId: listing.id, uploadId: photo.id, err: (error as Error).message }, "dropped photo not handed to the purge");
      }
    }),
  );
}

async function screenFor(listing: ListingDoc & { id: string }, seller: SellerContext, now: Date): Promise<ScreeningResult> {
  const [uploads, others] = await Promise.all([
    listing.photos.length > 0 ? getUploads(listing.photos.map((photo) => photo.id)) : Promise.resolve([]),
    listOwnerListingsByStatus(listing.ownerUid, [...ACTIVE_STATUSES, "paused", "rejected"]),
  ]);
  const facts = sellerFacts({
    accountCreatedAt: seller.user.createdAt,
    phoneVerified: seller.user.badges.phoneVerified,
    others: others.filter((other) => other.id !== listing.id),
    selfRejected: rejectedByModerator(listing),
    now,
  });
  return screen({ listing, uploads, seller: facts, others: others.filter((other) => other.status !== "rejected") }, listing.id);
}

/** Screening result on the listing; `held`: a person reviews it whatever the screen said. The hold's decision id is set by `commit`. */
function moderationPatch(current: ListingModeration, result: ScreeningResult, held = false): ListingModeration {
  return { ...current, state: held ? "needs_review" : result.state, score: result.score, flags: result.flags };
}

/**
 * A moderator rejected this listing (then the owner reopened it as a draft): its next publication
 * goes to a person again, whatever the automated screen says. Reopening and draft edits leave
 * `moderation.state` alone, so it still reads "human_rejected" at publish.
 */
function rejectedByModerator(listing: Pick<ListingDoc, "moderation">): boolean {
  return listing.moderation.state === "human_rejected";
}

export async function patchListing(actor: Actor, id: string, patch: ListingPatch, now = new Date()) {
  const listing = await ownedListing(actor, id);
  if (!EDITABLE_STATUSES.includes(listing.status)) throw new HttpError(409, "conflict", "listing is read-only in this status");
  const { uid } = actor.auth.user;
  // Not a draft autosave: a save may screen again and commits ~3 writes (listing.edit.uid).
  if (listing.status !== "draft") await enforceLimit("listing.edit.uid", uid);
  const seller = await sellerOf(actor.auth);
  const fields = changedFields(listing, await fieldsOf(listing, patch, { uid, quotas: seller.quotas, now }));
  // Nothing changes: nothing is written. A rejected listing's save reopens it, even an empty one.
  if (Object.keys(fields).length === 0 && listing.status !== "rejected") return ownerListingView(listing);
  let effects: TransitionEffects = { search: null, contentOp: null, audit: null, revalidate: false, mail: null };
  let mail: MailJob | null = null;
  let hold: ModerationDecisionInput | undefined;
  let maxDrafts: number | undefined;
  let maxActive: number | null | undefined;

  if (SCREENED_STATUSES.includes(listing.status)) {
    const next = applyPatch(listing, fields);
    const blockers = assessReadiness(next, { seller: seller.seller, phoneVerified: seller.user.badges.phoneVerified });
    if (blockers.length > 0) throw invalidListing(blockers);
    // Kept as is: indexed again when published, its public page refreshed (paused and expired too).
    effects = { search: listing.status === "published" ? "upsert" : null, contentOp: { op: "listing.update", ip: actor.ip }, audit: null, revalidate: hasPublicPage(listing.status), mail: null };
    if (SCREENED_FIELDS.some((field) => fields[field] !== undefined)) {
      const result = await screenFor(next, seller, now);
      if (result.blockers.length > 0) throw invalidListing(result.blockers);
      if (result.state === "needs_review" && listing.status !== "pending_review") {
        // Everything that can refuse comes first; the hold decision is written with the listing.
        const ctx = { now, lifetime: await lifetime(), ip: actor.ip };
        const held = step(() => transition(listing, "pending_review", ctx));
        // Paused and expired listings free their slot; held for review, the listing takes one again.
        if (!ACTIVE_STATUSES.includes(listing.status)) {
          await assertWithinQuota(uid, seller.quotas);
          maxActive = seller.quotas.activeListings;
        }
        Object.assign(fields, held.patch);
        fields.moderation = moderationPatch(fields.moderation ?? listing.moderation, result);
        fields.adsEligible = false;
        effects = held.effects;
        hold = holdRecord(listing, result, now);
        mail = { template: "listingPendingReview", statement: statementOf("hold", result.flags, await redressAddress()) };
      } else {
        fields.moderation = moderationPatch(fields.moderation ?? listing.moderation, result);
        fields.adsEligible = result.state === "auto_ok" && listing.status !== "pending_review" && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;
      }
    }
  } else if (listing.status === "rejected") {
    // Editing a rejected listing reopens it as a draft (lifecycle: rejected -> draft), under the draft cap (D2).
    const ctx = { now, lifetime: await lifetime(), ip: actor.ip };
    const reopened = step(() => transition(listing, "draft", ctx));
    Object.assign(fields, reopened.patch);
    effects = reopened.effects;
    maxDrafts = MAX_DRAFTS;
  }

  const updated = await commit(listing, fields, effects, { actor, user: seller.user, now, hold, maxDrafts, maxActive });
  if (fields.photos) await releaseDroppedPhotos(listing, fields.photos, now);
  if (mail) await notifySeller(updated, seller.user, mail);
  return ownerListingView(updated);
}

// ---- Publication ----------------------------------------------------------------------------

export interface PublishOptions {
  turnstileToken?: string;
  device: Device;
  now?: Date;
}

export interface PublishOutcome {
  response: PublishListingResponse;
  /** The request solved a Turnstile challenge: the response sets the pass cookie. */
  turnstilePassed: boolean;
}

/**
 * Publish (§7 steps 1-5, design D8): readiness blockers, pre-moderation blockers (422), active
 * quota, IP escalation, 5-per-day limiter, then the transition to `published` (indexed, mailed)
 * or `pending_review` (held, statement mailed), in one transaction with searchOutbox, contentOps
 * and the hold decision. A listing a moderator rejected before is always held.
 */
export async function publish(actor: Actor, request: Request, id: string, options: PublishOptions): Promise<PublishOutcome> {
  const now = options.now ?? new Date();
  const listing = await ownedListing(actor, id);
  if (listing.status !== "draft") throw new HttpError(409, "conflict", `cannot publish a ${listing.status} listing`);
  const seller = await sellerOf(actor.auth);
  const { uid } = actor.auth.user;

  const blockers = assessReadiness(listing, { seller: seller.seller, phoneVerified: seller.user.badges.phoneVerified });
  if (blockers.length > 0) throw invalidListing(blockers);
  const screening = await screenFor(listing, seller, now);
  if (screening.blockers.length > 0) throw invalidListing(screening.blockers);

  await assertWithinQuota(uid, seller.quotas);
  const turnstilePassed = await escalateOnIp(request, "listing.create.ip", options.device, options.turnstileToken, "listing");
  await enforceDailyLimit(uid, seller.quotas, now);

  const city = cityBySlug(listing.location!.citySlug)!;
  const slugId = buildSlugId({ id, title: listing.title, city: cityName(city, "fr"), categoryId: listing.categoryId });
  const rejectedBefore = rejectedByModerator(listing);
  const to: ListingStatus = screening.state === "needs_review" || rejectedBefore ? "pending_review" : "published";
  const ctx = { now, lifetime: await lifetime(), ip: actor.ip };
  const { patch, effects } = step(() => transition(listing, to, ctx));
  patch.slugId = slugId;
  patch.moderation = moderationPatch(listing.moderation, screening, to === "pending_review");
  patch.adsEligible = to === "published" && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;
  const hold = to === "pending_review" ? holdRecord(listing, screening, now, rejectedBefore) : undefined;

  const updated = await commit(listing, patch, effects, { actor, user: seller.user, now, hold, maxActive: seller.quotas.activeListings });
  const path = `/${seller.user.locale}/annonce/${slugId}`;
  if (to === "published") await notifySeller(updated, seller.user, { template: "listingPublished", path });
  else await notifySeller(updated, seller.user, { template: "listingPendingReview", statement: statementOf("hold", screening.flags, await redressAddress()) });

  return {
    response: { status: to, slugId, ...(to === "published" ? { url: path } : {}), flags: screening.flags, blockers: [] },
    turnstilePassed,
  };
}

/** 5 listings a day per account (D5): the limiter, else (store down, policy open) the Firestore count. */
async function enforceDailyLimit(uid: string, quotas: ListingQuotas, now: Date): Promise<void> {
  const outcome = await consumeLimit("listing.create.uid", uid);
  if (outcome.ok) return;
  if (outcome.reason === "limited") throw new HttpError(429, "listing_daily_limit", undefined, { headers: { "Retry-After": String(Math.max(1, outcome.retryAfterSeconds)) } });
  if (quotas.listingsPerDay !== null && (await countPublishedSince(uid, new Date(now.getTime() - DAY_MS))) >= quotas.listingsPerDay) {
    throw new HttpError(429, "listing_daily_limit", undefined, { headers: { "Retry-After": "3600" } });
  }
}

/**
 * moderationDecisions entry of an automated hold (art. 17: the statement is mailed with it),
 * written by `commit` in the listing's transaction. `rejectedBefore`: held because a moderator
 * rejected the listing before.
 */
function holdRecord(listing: ListingRecord, result: ScreeningResult, now: Date, rejectedBefore = false): ModerationDecisionInput {
  const facts = [...(result.flags.length > 0 ? [`flags: ${result.flags.join(", ")}`] : []), `score ${result.score}`, ...(rejectedBefore ? ["previously rejected by a moderator"] : [])];
  return {
    target: { type: "listing", id: listing.id },
    affectedUid: listing.ownerUid,
    action: "restrict_visibility",
    facts: facts.join("; "),
    origin: "own_initiative",
    automation: { detection: true, decision: true },
    ground: {
      type: "terms",
      ref: AUTOMATED_GROUND,
      explanation: rejectedBefore ? "A moderator rejected this listing before: a person reviews it again before publication." : "Pre-publication screening held the listing for human review.",
    },
    reportIds: [],
    templateId: "listingPendingReview",
    decidedBy: "system",
    notified: true,
    now,
  };
}

// ---- Owner actions --------------------------------------------------------------------------

/**
 * Owner actions (D16). Resume takes an active slot back (quota, 409 `listing_limit`); an expired
 * listing's renewal is screened like a publication (`renewExpired`). Removal keeps the photos:
 * retention-purge deletes text and media together at purgeAt (§5, §7 retention table).
 */
export async function changeStatus(actor: Actor, id: string, action: OwnerAction, now = new Date()): Promise<ListingRecord> {
  const listing = await ownedListing(actor, id);
  const seller = await sellerOf(actor.auth);
  const ctx: TransitionContext = { now, lifetime: await lifetime(), ip: actor.ip };
  if (action === "renew" && listing.status === "expired") return renewExpired(actor, listing, seller, ctx);
  const result = step(() => {
    switch (action) {
      case "pause":
        return transition(listing, "paused", ctx);
      case "resume":
        if (listing.status !== "paused") throw new IllegalTransitionError(listing.status, "published", "only a paused listing resumes");
        return transition(listing, "published", ctx);
      case "sold":
        return transition(listing, "sold", ctx);
      case "renew":
        // A published listing in its last week: same content, same slot, renewed in place.
        return renew(listing, ctx);
      case "remove":
        return transition(listing, "removed", ctx);
    }
  });
  if (action === "resume") await assertWithinQuota(actor.auth.user.uid, seller.quotas);
  return commit(listing, result.patch, result.effects, { actor, user: seller.user, now, ...(action === "resume" ? { maxActive: seller.quotas.activeListings } : {}) });
}

/**
 * A moderator approved this content and no screened edit came since: patchListing replaces
 * `moderation.state` on every change of a screened field, other edits and photo removals keep it.
 */
function approvedByModerator(listing: Pick<ListingDoc, "moderation">): boolean {
  return listing.moderation.state === "human_ok";
}

/**
 * Renewal of an expired listing (D16): back on a public page and in search, so screened like a
 * publication: readiness and pre-moderation blockers (422), active quota (409), then `published`
 * with a fresh lifetime, or `pending_review` when flagged (or rejected by a moderator before);
 * the approval then dates its new lifetime. Content a moderator approved and unchanged since is
 * not held again (project decision): a person already reviewed it, so a flag only repeats what
 * they saw; readiness and hard blockers still apply, and the approval stays on the listing.
 */
async function renewExpired(actor: Actor, listing: ListingRecord, seller: SellerContext, ctx: TransitionContext): Promise<ListingRecord> {
  const { now } = ctx;
  if (!canRenew(listing, now)) throw new HttpError(409, "conflict", "listing cannot be renewed any more");
  const blockers = assessReadiness(listing, { seller: seller.seller, phoneVerified: seller.user.badges.phoneVerified });
  if (blockers.length > 0) throw invalidListing(blockers);
  // Before the screening (the seller's other listings): a retry at the quota costs ~3 reads, not ~60.
  await assertWithinQuota(actor.auth.user.uid, seller.quotas);
  const screening = await screenFor(listing, seller, now);
  if (screening.blockers.length > 0) throw invalidListing(screening.blockers);

  const rejectedBefore = rejectedByModerator(listing);
  const approved = approvedByModerator(listing);
  const held = (screening.state === "needs_review" && !approved) || rejectedBefore;
  const { patch, effects } = step(() => (held ? renewForReview(listing, ctx) : renew(listing, ctx)));
  if (!approved) patch.moderation = moderationPatch(listing.moderation, screening, held);
  patch.adsEligible = !held && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;
  const hold = held ? holdRecord(listing, screening, now, rejectedBefore) : undefined;
  const updated = await commit(listing, patch, effects, { actor, user: seller.user, now, hold, maxActive: seller.quotas.activeListings });
  if (held) await notifySeller(updated, seller.user, { template: "listingPendingReview", statement: statementOf("hold", screening.flags, await redressAddress()) });
  return updated;
}

export function isAllowedTransition(from: ListingStatus, to: ListingStatus): boolean {
  return canTransition(from, to);
}

// ---- Commit and notifications -----------------------------------------------------------------

interface CommitContext {
  actor: Actor;
  user: UserRecord;
  now: Date;
  /** Automated hold decision, written in the same transaction; its id becomes `moderation.lastDecisionId`. */
  hold?: ModerationDecisionInput;
  /** Draft cap (D2) checked in the transaction: a rejected listing reopened as a draft. */
  maxDrafts?: number;
  /**
   * `activeListings` quota (null: none) checked in the transaction when the listing takes a slot
   * (publish, resume, renewal of an expired listing, held edit of a paused or expired one):
   * assertWithinQuota is only the fast path, two changes in parallel both pass it at 19 of 20.
   */
  maxActive?: number | null;
}

/**
 * Writes the patch (version = read version + 1) with the searchOutbox and contentOps entries and
 * the hold decision in one transaction: a concurrent change answers 409 and leaves no decision
 * behind. Audit and ISR revalidation follow the commit.
 */
async function commit(listing: ListingRecord, patch: ListingFieldPatch, effects: TransitionEffects, ctx: CommitContext): Promise<ListingRecord> {
  const version = listing.version + 1;
  const full: ListingFieldPatch = { ...patch, version, updatedAt: ctx.now };
  try {
    await db().runTransaction(async (tx) => {
      const current = await getListingTx(tx, listing.id);
      if (!current || current.version !== listing.version) throw new ListingVersionError();
      if (ctx.maxDrafts !== undefined && (await countDraftsTx(tx, listing.ownerUid)) >= ctx.maxDrafts) throw new DraftLimitError();
      if (typeof ctx.maxActive === "number" && !withinQuota(ctx.maxActive, await countActiveTx(tx, listing.ownerUid))) throw new ActiveLimitError();
      // Reads above, writes below (Firestore transactions). A retry records a fresh decision id.
      if (ctx.hold) full.moderation = { ...(full.moderation ?? current.moderation), lastDecisionId: recordModerationDecisionTx(tx, ctx.hold) };
      updateListingTx(tx, listing.id, full);
      if (effects.search) enqueueSearchOutboxTx(tx, listing.id, effects.search, version, ctx.now);
      if (effects.contentOp && ctx.actor.ip) recordContentOpTx(tx, { uid: ctx.actor.auth.user.uid, op: effects.contentOp.op, contentRef: listingContentRef(listing.id), ip: ctx.actor.ip, now: ctx.now });
    });
  } catch (error) {
    if (error instanceof ListingVersionError) throw new HttpError(409, "conflict", "listing changed meanwhile, reload it");
    if (error instanceof DraftLimitError) throw new HttpError(409, "draft_limit");
    if (error instanceof ActiveLimitError) throw new HttpError(409, "listing_limit");
    throw error;
  }
  const updated = applyPatch(listing, full);
  if (effects.audit) {
    await audit({
      actorUid: ctx.actor.auth.user.uid,
      actorRole: ctx.actor.auth.user.claims.role ?? "individual",
      action: effects.audit,
      target: { type: "listing", id: listing.id },
      automated: false,
      ...(ctx.actor.ip ? { ip: ctx.actor.ip } : {}),
      at: ctx.now,
    });
  }
  if (effects.revalidate) revalidateListingPaths({ slugId: updated.slugId ?? listing.slugId, publicId: ctx.user.publicId });
  return updated;
}

type MailJob = { template: "listingPublished"; path: string } | { template: "listingPendingReview" | "listingRejected"; statement: ModerationStatement };

async function redressAddress(): Promise<string> {
  return (await getLegalConfig()).dsaContactEmail;
}

export function statementOf(measure: ModerationStatement["measure"], flags: readonly ModerationFlag[], redress: string): ModerationStatement {
  return { measure, facts: [...flags], ground: AUTOMATED_GROUND, automated: true, redress };
}

/** Transactional mail to the seller; a mail failure never fails the request (logged, the state is written). */
async function notifySeller(listing: ListingRecord, user: UserRecord, job: MailJob): Promise<void> {
  try {
    const account = await getUserPrivate(user.uid);
    if (!account?.email) return;
    const base = { displayName: user.displayName, title: listing.title };
    const idempotencyKey = `${job.template}-${listing.id}-${listing.version}`;
    if (job.template === "listingPublished") {
      const data: TemplateData["listingPublished"] = { ...base, url: `${serverEnv().SITE_URL.replace(/\/$/, "")}${job.path}`, expiresAt: (listing.expiresAt ?? listing.updatedAt).toISOString() };
      await sendMail({ template: "listingPublished", locale: user.locale, to: account.email, data, priority: "transactional", idempotencyKey });
    } else {
      const data: TemplateData["listingPendingReview"] = { ...base, listingId: listing.id, statement: job.statement };
      await sendMail({ template: job.template, locale: user.locale, to: account.email, data, priority: "transactional", idempotencyKey });
    }
  } catch (error) {
    logger.error({ err: (error as Error).message, listingId: listing.id, template: job.template }, "listing mail failed");
  }
}
