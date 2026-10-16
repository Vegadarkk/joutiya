import "server-only";
import { subcategoryById } from "@/config/categories";
import { listingLifetime, listingQuotas, withinQuota, type ListingQuotas, type Seller } from "@/config/pricing";
import { cityBySlug, cityName } from "@/config/regions";
import type { AuthContext } from "@/lib/auth/guards";
import { requireOwner } from "@/lib/auth/guards";
import type { Device } from "@/lib/auth/respond";
import { audit } from "@/lib/audit";
import { MAX_DRAFTS, type CreateListingInput, type FieldIssue, type ListingPatch, type ListingStatus, type ModerationFlag, type PublishListingResponse } from "@/lib/contracts/listings";
import { listingPhotoSchema } from "@/lib/contracts/media";
import { listingContentRef, recordContentOp, recordContentOpTx } from "@/lib/db/repositories/content-ops";
import {
  ACTIVE_STATUSES,
  DraftLimitError,
  ListingVersionError,
  applyPatch,
  countActive,
  countPublishedSince,
  createListing,
  getListing,
  getListingTx,
  listOwnerListingsByStatus,
  updateListingTx,
  type ListingFieldPatch,
  type ListingRecord,
} from "@/lib/db/repositories/listings";
import { recordModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { getUploads, listUploadsByTarget, updateUpload } from "@/lib/db/repositories/uploads";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { listingSchema, type ListingDoc, type ListingModeration } from "@/lib/db/schemas";
import { serverEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { ModerationStatement, TemplateData } from "@/lib/mail/types";
import { consumeLimit } from "@/lib/rate-limit/limiter";
import { escalateOnIp } from "./escalation";
import { buildSlugId, newListingId } from "./ids";
import { IllegalTransitionError, canTransition, renew, transition, type Lifetime, type TransitionEffects } from "./lifecycle";
import { ownerListingView } from "./owner-view";
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
/** Live listings: an edit is re-screened and may fall back to pending_review. */
const LIVE_STATUSES: readonly ListingStatus[] = ["published", "paused", "pending_review"];
/** Fields whose change re-runs the pre-moderation on a live listing. */
const SCREENED_FIELDS: readonly (keyof ListingDoc)[] = ["title", "description", "attributes", "categoryId", "subcategoryId", "price", "isDonation", "photos", "contact"];
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
    const { sensitiveDeclaration: _dropped, ...rest } = listing.moderation;
    fields.moderation = patch.sensitiveDeclaration ? { ...rest, sensitiveDeclaration: { kind: patch.sensitiveDeclaration.kind, at: ctx.now } } : rest;
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

async function screenFor(listing: ListingDoc & { id: string }, seller: SellerContext, now: Date): Promise<ScreeningResult> {
  const [uploads, others] = await Promise.all([
    listing.photos.length > 0 ? getUploads(listing.photos.map((photo) => photo.id)) : Promise.resolve([]),
    listOwnerListingsByStatus(listing.ownerUid, [...ACTIVE_STATUSES, "paused", "rejected"]),
  ]);
  const facts = sellerFacts({ accountCreatedAt: seller.user.createdAt, phoneVerified: seller.user.badges.phoneVerified, others: others.filter((other) => other.id !== listing.id), now });
  return screen({ listing, uploads, seller: facts, others: others.filter((other) => other.status !== "rejected") }, listing.id);
}

function moderationPatch(current: ListingModeration, result: ScreeningResult, lastDecisionId?: string): ListingModeration {
  return { ...current, state: result.state, score: result.score, flags: result.flags, ...(lastDecisionId ? { lastDecisionId } : {}) };
}

export async function patchListing(actor: Actor, id: string, patch: ListingPatch, now = new Date()) {
  const listing = await ownedListing(actor, id);
  if (!EDITABLE_STATUSES.includes(listing.status)) throw new HttpError(409, "conflict", "listing is read-only in this status");
  const seller = await sellerOf(actor.auth);
  const { uid } = actor.auth.user;
  const fields = await fieldsOf(listing, patch, { uid, quotas: seller.quotas, now });
  let effects: TransitionEffects = { search: null, contentOp: null, audit: null, revalidate: false, mail: null };
  let mail: MailJob | null = null;

  if (LIVE_STATUSES.includes(listing.status)) {
    const next = applyPatch(listing, fields);
    const blockers = assessReadiness(next, { seller: seller.seller, phoneVerified: seller.user.badges.phoneVerified });
    if (blockers.length > 0) throw invalidListing(blockers);
    if (SCREENED_FIELDS.some((field) => fields[field] !== undefined)) {
      const result = await screenFor(next, seller, now);
      if (result.blockers.length > 0) throw invalidListing(result.blockers);
      if (result.state === "needs_review" && listing.status !== "pending_review") {
        const decisionId = await holdDecision(listing, result, now);
        fields.moderation = moderationPatch(fields.moderation ?? listing.moderation, result, decisionId);
        fields.adsEligible = false;
        const held = transition(listing, "pending_review", { now, lifetime: await lifetime(), ip: actor.ip });
        Object.assign(fields, held.patch);
        effects = held.effects;
        mail = { template: "listingPendingReview", statement: statementOf("hold", result.flags, await redressAddress()) };
      } else {
        fields.moderation = moderationPatch(fields.moderation ?? listing.moderation, result);
        fields.adsEligible = result.state === "auto_ok" && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;
        effects = { search: listing.status === "published" ? "upsert" : null, contentOp: { op: "listing.update", ip: actor.ip }, audit: null, revalidate: listing.status === "published", mail: null };
      }
    } else {
      effects = { search: listing.status === "published" ? "upsert" : null, contentOp: { op: "listing.update", ip: actor.ip }, audit: null, revalidate: listing.status === "published", mail: null };
    }
  } else if (listing.status === "rejected") {
    // Editing a rejected listing reopens it as a draft (lifecycle: rejected -> draft).
    const reopened = transition(listing, "draft", { now, lifetime: await lifetime(), ip: actor.ip });
    Object.assign(fields, reopened.patch);
    effects = reopened.effects;
  }

  const updated = await commit(listing, fields, effects, { actor, user: seller.user, now });
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
 * or `pending_review` (held, statement mailed), in one transaction with searchOutbox and contentOps.
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

  if (!withinQuota(seller.quotas.activeListings, await countActive(uid))) throw new HttpError(409, "listing_limit");
  const turnstilePassed = await escalateOnIp(request, "listing.create.ip", options.device, options.turnstileToken, "listing");
  await enforceDailyLimit(uid, seller.quotas, now);

  const city = cityBySlug(listing.location!.citySlug)!;
  const slugId = buildSlugId({ id, title: listing.title, city: cityName(city, "fr"), categoryId: listing.categoryId });
  const to: ListingStatus = screening.state === "needs_review" ? "pending_review" : "published";
  const decisionId = to === "pending_review" ? await holdDecision(listing, screening, now) : undefined;
  const { patch, effects } = transition(listing, to, { now, lifetime: await lifetime(), ip: actor.ip });
  patch.slugId = slugId;
  patch.moderation = moderationPatch(listing.moderation, screening, decisionId);
  patch.adsEligible = to === "published" && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;

  const updated = await commit(listing, patch, effects, { actor, user: seller.user, now });
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

/** moderationDecisions entry of an automated hold (art. 17: the statement is mailed with it). */
async function holdDecision(listing: ListingRecord, result: ScreeningResult, now: Date): Promise<string> {
  return recordModerationDecision({
    target: { type: "listing", id: listing.id },
    affectedUid: listing.ownerUid,
    action: "restrict_visibility",
    facts: result.flags.length > 0 ? `flags: ${result.flags.join(", ")}; score ${result.score}` : `score ${result.score}`,
    origin: "own_initiative",
    automation: { detection: true, decision: true },
    ground: { type: "terms", ref: AUTOMATED_GROUND, explanation: "Pre-publication screening held the listing for human review." },
    reportIds: [],
    templateId: "listingPendingReview",
    decidedBy: "system",
    notified: true,
    now,
  });
}

// ---- Owner actions --------------------------------------------------------------------------

export async function changeStatus(actor: Actor, id: string, action: OwnerAction, now = new Date()): Promise<ListingRecord> {
  const listing = await ownedListing(actor, id);
  const seller = await sellerOf(actor.auth);
  const ctx = { now, lifetime: await lifetime(), ip: actor.ip };
  let result;
  try {
    switch (action) {
      case "pause":
        result = transition(listing, "paused", ctx);
        break;
      case "resume":
        if (listing.status !== "paused") throw new IllegalTransitionError(listing.status, "published", "only a paused listing resumes");
        result = transition(listing, "published", ctx);
        break;
      case "sold":
        result = transition(listing, "sold", ctx);
        break;
      case "renew":
        result = renew(listing, ctx);
        break;
      case "remove":
        result = transition(listing, "removed", ctx);
        break;
    }
  } catch (error) {
    if (error instanceof IllegalTransitionError) throw new HttpError(409, "conflict", error.message);
    throw error;
  }
  const updated = await commit(listing, result.patch, result.effects, { actor, user: seller.user, now });
  if (action === "remove") await scheduleUploadPurge(listing, now);
  return updated;
}

/**
 * Removal: the photos' objects go with the retention purge. The upload documents get `purgeAt =
 * now`; retention-purge (media lot) deletes the objects and the documents on its next run.
 */
async function scheduleUploadPurge(listing: ListingRecord, now: Date): Promise<void> {
  const uploads = await listUploadsByTarget(listing.id);
  await Promise.all(uploads.map((upload) => updateUpload(upload.id, { purgeAt: now }, now)));
}

export function isAllowedTransition(from: ListingStatus, to: ListingStatus): boolean {
  return canTransition(from, to);
}

// ---- Commit and notifications -----------------------------------------------------------------

interface CommitContext {
  actor: Actor;
  user: UserRecord;
  now: Date;
}

/**
 * Writes the patch (version = read version + 1) with the searchOutbox and contentOps entries in
 * one transaction; a concurrent change answers 409. Audit and ISR revalidation follow the commit.
 */
async function commit(listing: ListingRecord, patch: ListingFieldPatch, effects: TransitionEffects, ctx: CommitContext): Promise<ListingRecord> {
  const version = listing.version + 1;
  const full: ListingFieldPatch = { ...patch, version, updatedAt: ctx.now };
  try {
    await db().runTransaction(async (tx) => {
      const current = await getListingTx(tx, listing.id);
      if (!current || current.version !== listing.version) throw new ListingVersionError();
      updateListingTx(tx, listing.id, full);
      if (effects.search) enqueueSearchOutboxTx(tx, listing.id, effects.search, version, ctx.now);
      if (effects.contentOp && ctx.actor.ip) recordContentOpTx(tx, { uid: ctx.actor.auth.user.uid, op: effects.contentOp.op, contentRef: listingContentRef(listing.id), ip: ctx.actor.ip, now: ctx.now });
    });
  } catch (error) {
    if (error instanceof ListingVersionError) throw new HttpError(409, "conflict", "listing changed meanwhile, reload it");
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
