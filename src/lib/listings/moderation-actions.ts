import "server-only";
import { listingLifetime } from "@/config/pricing";
import { cityBySlug, cityName } from "@/config/regions";
import type { StaffContext } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import type { ListingStatus, ModerationFlag, ModerationState, SensitiveDeclarationKind } from "@/lib/contracts/listings";
import type { ListingPhoto, UploadStatus } from "@/lib/contracts/media";
import { ACTIVE_STATUSES, ListingVersionError, applyPatch, getListing, getListingTx, listOwnerListingsByStatus, updateListingTx, type ListingRecord } from "@/lib/db/repositories/listings";
import { getModerationDecision, listDecisionsForUser, listPendingReview, recordModerationDecisionTx, type ModerationDecisionInput } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { getUploads } from "@/lib/db/repositories/uploads";
import type { ModerationDecisionDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient, siteUrl } from "@/lib/mail/recipients";
import { APPROVAL_GROUND, REJECT_REASONS, rejectStatementFacts, type ModerationDecisionRequest, type ModerationDecisionResponse } from "@/lib/moderation/decisions";
import type { RequestIdentity } from "@/lib/rate-limit/keys";
import { notifySearchIndex } from "@/lib/search/queue";
import { buildSlugId } from "./ids";
import { IllegalTransitionError, approvalOutcome, approveHold, holdKind, transition, type ApprovalOutcome, type HoldKind, type TransitionResult } from "./lifecycle";
import { revalidateListingPaths } from "./revalidate";
import { screen, sellerFacts } from "./screening";

// Minimal moderation queue of the back office (design D9, architecture §7 step 8, phase 5
// preview): the listings held by the pre-moderation, a review view, and the moderator's approval
// or rejection. A decision is one transaction that re-checks status and version (two moderators,
// or the seller editing meanwhile, get a 409), writes the listing, the searchOutbox entry and the
// moderationDecisions statement; the audit entry, the ISR revalidation and the seller's mail follow.
// No contentOps entry: it records the seller's own operations with their IP (LCEN), and the seller's
// publish request already wrote one.

export const QUEUE_PAGE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses a moderator may open (drafts stay the seller's own work in progress). */
const REVIEWABLE: readonly ListingStatus[] = ["pending_review", "published", "paused", "sold", "expired", "rejected", "removed"];

export interface ModerationQueueItem {
  id: string;
  version: number;
  title: string;
  categoryId: string | null;
  subcategoryId: string | null;
  citySlug: string | null;
  price: number | null;
  isDonation: boolean;
  /** First photo (thumbnail), null without photos. */
  photo: ListingPhoto | null;
  photoCount: number;
  flags: ModerationFlag[];
  score: number;
  seller: { displayName: string; publicId: string; type: "individual" | "pro" };
  /** What is held: a first publication, an expired listing's renewal, or an edit after publication. */
  hold: HoldKind;
  /** ISO: the hold, or the seller's last edit while held. */
  waitingSince: string;
  createdAt: string;
}

export interface ModerationQueueResponse {
  items: ModerationQueueItem[];
  hasMore: boolean;
}

export interface ModerationReviewPhoto extends ListingPhoto {
  checks: { nsfw?: number; faces?: number } | null;
  uploadStatus: UploadStatus | null;
}

export interface ModerationReview {
  listing: {
    id: string;
    version: number;
    status: ListingStatus;
    title: string;
    description: string;
    categoryId: string | null;
    subcategoryId: string | null;
    attributes: ListingRecord["attributes"];
    condition: ListingRecord["condition"] | null;
    price: number | null;
    priceNegotiable: boolean;
    isDonation: boolean;
    location: { regionCode: string; citySlug: string; district: string | null } | null;
    contact: { showPhone: boolean; whatsapp: boolean };
    photos: ModerationReviewPhoto[];
    slugId: string | null;
    createdAt: string;
    updatedAt: string;
    publishedAt: string | null;
    expiresAt: string | null;
  };
  moderation: {
    state: ModerationState;
    score: number;
    flags: ModerationFlag[];
    sensitiveDeclaration: SensitiveDeclarationKind | null;
    /** The decision that put the listing here (automated hold) or the last one taken. */
    lastDecision: { action: ModerationDecisionDoc["action"]; facts: string; ground: string; automated: boolean; createdAt: string } | null;
    reviewedAt: string | null;
  };
  /** What an approval would give (published, or back to paused / expired); null when not pending. */
  approval: ApprovalOutcome | null;
  /** The pre-moderation re-run on the current content (evidence never quotes the matched text); null if it failed. */
  screening: { state: "auto_ok" | "needs_review"; score: number; flags: ModerationFlag[]; evidence: string[] } | null;
  seller: {
    displayName: string;
    publicId: string;
    type: "individual" | "pro";
    status: UserRecord["status"] | "unknown";
    accountAgeDays: number | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    /** Published or pending listings. */
    activeListings: number;
    rejectedListings: number;
    decisions: { action: ModerationDecisionDoc["action"]; templateId: string; automated: boolean; createdAt: string }[];
  };
}

const iso = (date: Date | undefined) => (date ? date.toISOString() : null);

function queueItem(listing: ListingRecord): ModerationQueueItem {
  return {
    id: listing.id,
    version: listing.version,
    title: listing.title,
    categoryId: listing.categoryId ?? null,
    subcategoryId: listing.subcategoryId ?? null,
    citySlug: listing.location?.citySlug ?? null,
    price: listing.price,
    isDonation: listing.isDonation,
    photo: listing.photos[0] ?? null,
    photoCount: listing.photos.length,
    flags: listing.moderation.flags,
    score: listing.moderation.score,
    seller: { displayName: listing.sellerName, publicId: listing.sellerPublicId, type: listing.sellerType },
    hold: holdKind(listing),
    waitingSince: listing.updatedAt.toISOString(),
    createdAt: listing.createdAt.toISOString(),
  };
}

/** Listings awaiting a decision, oldest first. */
export async function moderationQueue(limit = QUEUE_PAGE): Promise<ModerationQueueResponse> {
  const records = await listPendingReview(limit + 1);
  return { items: records.slice(0, limit).map(queueItem), hasMore: records.length > limit };
}

/** Everything a moderator needs to decide on one listing; null when it does not exist (or is a draft). */
export async function moderationReview(id: string, now = new Date()): Promise<ModerationReview | null> {
  const listing = await getListing(id);
  if (!listing || !REVIEWABLE.includes(listing.status)) return null;
  const [user, uploads, others, decisions, lastDecision] = await Promise.all([
    getUserRecord(listing.ownerUid),
    getUploads(listing.photos.map((photo) => photo.id)),
    listOwnerListingsByStatus(listing.ownerUid, [...ACTIVE_STATUSES, "paused", "rejected"]),
    listDecisionsForUser(listing.ownerUid, 10),
    listing.moderation.lastDecisionId ? getModerationDecision(listing.moderation.lastDecisionId) : Promise.resolve(null),
  ]);
  const uploadById = new Map(uploads.map((upload) => [upload.id, upload]));
  const otherListings = others.filter((other) => other.id !== listing.id);

  let screening: ModerationReview["screening"] = null;
  try {
    const facts = sellerFacts({ accountCreatedAt: user?.createdAt ?? listing.createdAt, phoneVerified: user?.badges.phoneVerified ?? false, others: otherListings, now });
    const result = await screen({ listing, uploads, seller: facts, others: otherListings.filter((other) => other.status !== "rejected") }, listing.id);
    screening = { state: result.state, score: result.score, flags: result.flags, evidence: result.evidence };
  } catch (error) {
    logger.warn({ listingId: listing.id, err: (error as Error).message }, "moderation review: screening re-run failed");
  }

  return {
    listing: {
      id: listing.id,
      version: listing.version,
      status: listing.status,
      title: listing.title,
      description: listing.description,
      categoryId: listing.categoryId ?? null,
      subcategoryId: listing.subcategoryId ?? null,
      attributes: listing.attributes,
      condition: listing.condition ?? null,
      price: listing.price,
      priceNegotiable: listing.priceNegotiable,
      isDonation: listing.isDonation,
      location: listing.location ? { regionCode: listing.location.regionCode, citySlug: listing.location.citySlug, district: listing.location.district ?? null } : null,
      contact: { showPhone: listing.contact.showPhone, whatsapp: listing.contact.whatsapp },
      photos: listing.photos.map((photo) => {
        const upload = uploadById.get(photo.id);
        return { ...photo, checks: upload ? upload.checks : null, uploadStatus: upload?.status ?? null };
      }),
      slugId: listing.slugId ?? null,
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
      publishedAt: iso(listing.publishedAt),
      expiresAt: iso(listing.expiresAt),
    },
    moderation: {
      state: listing.moderation.state,
      score: listing.moderation.score,
      flags: listing.moderation.flags,
      sensitiveDeclaration: listing.moderation.sensitiveDeclaration?.kind ?? null,
      lastDecision: lastDecision
        ? { action: lastDecision.action, facts: lastDecision.facts, ground: lastDecision.ground.ref, automated: lastDecision.automation.decision, createdAt: lastDecision.createdAt.toISOString() }
        : null,
      reviewedAt: iso(listing.moderation.reviewedAt),
    },
    approval: listing.status === "pending_review" ? approvalOutcome(listing, now) : null,
    screening,
    seller: {
      displayName: listing.sellerName,
      publicId: listing.sellerPublicId,
      type: listing.sellerType,
      status: user?.status ?? "unknown",
      accountAgeDays: user ? Math.max(0, Math.floor((now.getTime() - user.createdAt.getTime()) / DAY_MS)) : null,
      emailVerified: user?.badges.emailVerified ?? false,
      phoneVerified: user?.badges.phoneVerified ?? false,
      activeListings: otherListings.filter((other) => ACTIVE_STATUSES.includes(other.status)).length + (ACTIVE_STATUSES.includes(listing.status) ? 1 : 0),
      rejectedListings: otherListings.filter((other) => other.status === "rejected").length,
      decisions: decisions.map((decision) => ({ action: decision.action, templateId: decision.templateId, automated: decision.automation.decision, createdAt: decision.createdAt.toISOString() })),
    },
  };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function decisionRecord(staff: StaffContext, listing: ListingRecord, input: ModerationDecisionRequest, approvedAs: ListingStatus, now: Date): ModerationDecisionInput {
  const common = {
    target: { type: "listing", id: listing.id },
    affectedUid: listing.ownerUid,
    origin: "own_initiative" as const,
    // The listing reached the queue through the automated screening; a person decided.
    automation: { detection: true, decision: false },
    reportIds: [],
    decidedBy: staff.user.uid,
    notified: true,
    now,
  };
  if (input.action === "approve") {
    return {
      ...common,
      action: "restore",
      facts: clip(`Human review: listing compliant${input.note ? `. Note: ${input.note}` : ""}`, 2000),
      ground: { ...APPROVAL_GROUND, explanation: approvedAs === "published" ? "The moderator lifted the automated hold after reviewing the listing." : `The moderator approved the held edit; the listing is ${approvedAs} again, as before the hold.` },
      templateId: approvedAs === "published" ? "listingApproved" : "listingChangesApproved",
    };
  }
  const reason = REJECT_REASONS[input.reason];
  return {
    ...common,
    action: "remove",
    facts: clip(`${reason.facts.fr}${input.details ? `. ${input.details}` : ""}`, 2000),
    ground: { type: reason.ground.type, ref: reason.ground.ref, explanation: `Rejected by a moderator: ${input.reason}.` },
    templateId: "listingRejected",
  };
}

/**
 * POST /api/admin/moderation/{id}: approval (lifecycle `approveHold`: a publication or a renewal is
 * published, an edit gets back the status the owner had: published with its dates, paused, or
 * expired when its expiry passed) or rejection (pending_review -> rejected, statement of reasons
 * mailed). 404 for an unknown listing, 409 when it is not pending any more or its version moved
 * since the review.
 */
export async function decide(staff: StaffContext, id: string, input: ModerationDecisionRequest, identity: RequestIdentity, now = new Date()): Promise<ModerationDecisionResponse> {
  const listing = await getListing(id);
  if (!listing) throw notFound();
  if (listing.status !== "pending_review") throw new HttpError(409, "conflict", "listing is not awaiting review");
  if (listing.version !== input.version) throw new HttpError(409, "conflict", "listing changed since it was reviewed, reload it");
  const legal = await getLegalConfig();
  const approve = input.action === "approve";

  const ctx = { now, lifetime: listingLifetime(legal) };
  let result: TransitionResult;
  try {
    result = approve ? approveHold(listing, ctx) : transition(listing, "rejected", ctx);
  } catch (error) {
    if (error instanceof IllegalTransitionError) throw new HttpError(409, "conflict", error.message);
    throw error;
  }
  const { patch, effects } = result;
  if (approve && !listing.slugId) {
    const city = listing.location ? cityBySlug(listing.location.citySlug) : undefined;
    patch.slugId = buildSlugId({ id, title: listing.title, city: city ? cityName(city, "fr") : undefined, categoryId: listing.categoryId });
  }
  const record = decisionRecord(staff, listing, input, patch.status, now);

  let decisionId = "";
  try {
    await db().runTransaction(async (tx) => {
      const current = await getListingTx(tx, id);
      if (!current || current.status !== "pending_review" || current.version !== input.version) throw new ListingVersionError();
      decisionId = recordModerationDecisionTx(tx, record);
      patch.moderation = { ...current.moderation, state: approve ? "human_ok" : "human_rejected", reviewedBy: staff.user.uid, reviewedAt: now, lastDecisionId: decisionId };
      patch.adsEligible = approve && current.moderation.openReports === 0 && !current.moderation.hiddenBy;
      updateListingTx(tx, id, patch);
      if (effects.search) enqueueSearchOutboxTx(tx, id, effects.search, patch.version, now);
    });
  } catch (error) {
    if (error instanceof ListingVersionError) throw new HttpError(409, "conflict", "listing changed meanwhile, reload it");
    throw error;
  }
  if (effects.search) await notifySearchIndex([id]);
  const updated = applyPatch(listing, patch);

  await audit({
    actorUid: staff.user.uid,
    actorRole: staff.role,
    action: effects.audit ?? (approve ? "listing.approve" : "listing.reject"),
    target: { type: "listing", id },
    automated: false,
    reason: approve ? `decision ${decisionId}` : `${input.reason}; decision ${decisionId}`,
    ip: identity.ip,
    at: now,
  });
  if (effects.revalidate) revalidateListingPaths({ slugId: updated.slugId, publicId: listing.sellerPublicId });
  await notifySeller(updated, input, legal.dsaContactEmail);
  return { status: approve ? (updated.status as ModerationDecisionResponse["status"]) : "rejected", decisionId };
}

/**
 * listingApproved (online now), listingChangesApproved (back to paused or expired: the changes are
 * approved, nothing is online) or listingRejected (statement of reasons, human decision); a
 * failure is logged, never thrown.
 */
async function notifySeller(listing: ListingRecord, input: ModerationDecisionRequest, redress: string): Promise<void> {
  const restored = listing.status === "paused" || listing.status === "expired" ? listing.status : null;
  const template = input.action === "reject" ? "listingRejected" : restored ? "listingChangesApproved" : "listingApproved";
  try {
    const to = await listingRecipient(listing.ownerUid);
    if (!to) return;
    const base = { locale: to.locale, to: to.email, priority: "transactional" as const, idempotencyKey: `${template}-${listing.id}-${listing.version}` };
    if (input.action === "approve" && restored) {
      // Paused: resumable until its expiry; expired: renewable until its purge date.
      const until = (restored === "paused" ? listing.expiresAt : listing.purgeAt) ?? listing.updatedAt;
      const url = siteUrl(to.locale, `mes-annonces?onglet=${restored === "paused" ? "active" : "ended"}`);
      await sendMail({ ...base, template: "listingChangesApproved", data: { displayName: to.displayName, title: listing.title, status: restored, url, until: until.toISOString() } });
    } else if (input.action === "approve") {
      const url = siteUrl(to.locale, listing.slugId ? `annonce/${listing.slugId}` : "mes-annonces");
      await sendMail({ ...base, template: "listingApproved", data: { displayName: to.displayName, title: listing.title, url, expiresAt: (listing.expiresAt ?? listing.updatedAt).toISOString() } });
    } else {
      const statement = { measure: "reject" as const, facts: rejectStatementFacts(input.reason, input.details), ground: REJECT_REASONS[input.reason].ground.ref, automated: false, redress };
      await sendMail({ ...base, template: "listingRejected", data: { displayName: to.displayName, title: listing.title, listingId: listing.id, statement } });
    }
  } catch (error) {
    logger.error({ listingId: listing.id, template, err: (error as Error).message }, "moderation mail failed");
  }
}
