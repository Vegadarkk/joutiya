import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { listingLifetime } from "@/config/pricing";
import { audit } from "@/lib/audit";
import { getListingTx, listOwnerListingsByStatus, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { auth, db } from "@/lib/firebase/admin";
import { getClaims, setClaims, type Claims } from "@/lib/firebase/claims";
import { getLegalConfig } from "@/lib/legal/config";
import { purgeAtFor, transition, type Lifetime } from "@/lib/listings/lifecycle";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { adsEligibleOf } from "@/lib/reports";
import { notifySearchIndex } from "@/lib/search/queue";
import { levelAfterReversal, type Sanction } from "./ladder";
import { privateFromSnapshot, privateRef, suspensionFromSnapshot, suspensionRef, userRef } from "./repository";

// Account sanctions (design D14): the Auth side (st claim for a suspension, disabled account and
// revoked tokens for a ban) is applied before the decision's transaction and undone if it fails;
// the listings follow after the commit (paused with pausedReason "moderation" for a suspension,
// removed for a ban, one transaction each, search outbox + fast lane, ISR revalidation).
// lift-suspensions and the appeal reversals undo them.

/** Listings one sanction touches at most (an individual has 20 active ones; Pro plans more). */
export const SANCTION_LISTINGS_MAX = 200;
const BAN_STATUSES = ["published", "paused", "pending_review"] as const;

export type Undo = () => Promise<void>;

/**
 * Auth side of a sanction; returns how to undo it (the decision's transaction failed). A
 * suspension adds `st: "suspended"` to the current claims (setClaims revokes the refresh tokens);
 * a ban disables the account and revokes its tokens (the claims stay, for a reversal).
 */
export async function applyAuthSanction(uid: string, sanction: Sanction): Promise<Undo> {
  if (sanction.action === "suspend_account") {
    const before = await getClaims(uid);
    if (before.st === "suspended") return async () => undefined;
    await setClaims(uid, { ...before, st: "suspended" });
    return async () => setClaims(uid, before);
  }
  if (sanction.action === "ban") {
    const record = await auth().getUser(uid);
    await auth().updateUser(uid, { disabled: true });
    await auth().revokeRefreshTokens(uid);
    const wasDisabled = record.disabled;
    return async () => {
      if (!wasDisabled) await auth().updateUser(uid, { disabled: false });
    };
  }
  return async () => undefined;
}

/** Runs an undo, logging (never throwing) when it fails too. */
export async function undoQuietly(undo: Undo, context: Record<string, unknown>): Promise<void> {
  try {
    await undo();
  } catch (error) {
    logger.error({ ...context, err: (error as Error).message }, "decisions: sanction rollback failed");
  }
}

/** Drops the `st` claim (lift, reversal); revokes the tokens through setClaims only when it changes. */
export async function clearSuspendedClaim(uid: string): Promise<void> {
  const claims: Claims = await getClaims(uid);
  if (claims.st !== "suspended") return;
  const { st: _st, ...rest } = claims;
  await setClaims(uid, rest);
}

export async function lifetime(): Promise<Lifetime> {
  return listingLifetime(await getLegalConfig());
}

interface ListingChange {
  patch: ListingFieldPatch & { version: number };
  search: "upsert" | "delete" | null;
}

interface ChangedListing {
  listing: ListingRecord;
  search: boolean;
}

/** One listing transaction: read, compute the change (null: leave it), write the patch and its outbox entry. */
async function changeListing(id: string, compute: (listing: ListingRecord) => ListingChange | null, now: Date): Promise<ChangedListing | null> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, id);
    if (!listing) return null;
    const change = compute(listing);
    if (!change) return null;
    updateListingTx(tx, id, change.patch);
    if (change.search) enqueueSearchOutboxTx(tx, id, change.search, change.patch.version, now);
    return { listing, search: change.search !== null };
  });
}

/** Search fast lane and ISR revalidation after listing changes (never throws). */
export async function afterListingChanges(changes: readonly ChangedListing[], publicId?: string): Promise<void> {
  try {
    await notifySearchIndex(changes.filter((change) => change.search).map((change) => change.listing.id));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "decisions: search fast lane failed");
  }
  for (const change of changes) revalidateListingPaths({ slugId: change.listing.slugId });
  const profile = publicId ?? changes[0]?.listing.sellerPublicId;
  if (profile) revalidateListingPaths({ publicId: profile });
}

/** Applies `compute` to each listing, one transaction each; a failure is logged and the next one goes on. */
async function changeListings(listings: readonly ListingRecord[], compute: (listing: ListingRecord) => ListingChange | null, now: Date, label: string): Promise<ChangedListing[]> {
  const changes: ChangedListing[] = [];
  for (const listing of listings) {
    try {
      const change = await changeListing(listing.id, compute, now);
      if (change) changes.push(change);
    } catch (error) {
      logger.error({ listingId: listing.id, err: (error as Error).message }, `decisions: ${label} failed for a listing`);
    }
  }
  await afterListingChanges(changes);
  return changes;
}

/** Suspension (D14): the published listings are paused with pausedReason "moderation". */
export async function pauseListingsForSuspension(uid: string, now: Date): Promise<string[]> {
  const life = await lifetime();
  const listings = await listOwnerListingsByStatus(uid, ["published"], SANCTION_LISTINGS_MAX);
  const changes = await changeListings(
    listings,
    (listing) => {
      if (listing.status !== "published") return null;
      const { patch } = transition(listing, "paused", { now, lifetime: life, pausedReason: "moderation" });
      return { patch: { ...patch, adsEligible: false }, search: "delete" };
    },
    now,
    "suspension pause",
  );
  return changes.map((change) => change.listing.id);
}

/** End of a suspension: listings paused by moderation come back, published if not expired, else expired (renewable). */
export async function resumeModerationPaused(uid: string, now: Date): Promise<string[]> {
  const life = await lifetime();
  const listings = (await listOwnerListingsByStatus(uid, ["paused"], SANCTION_LISTINGS_MAX)).filter((listing) => listing.pausedReason === "moderation");
  const changes = await changeListings(
    listings,
    (listing) => {
      if (listing.status !== "paused" || listing.pausedReason !== "moderation") return null;
      const live = listing.expiresAt !== undefined && listing.expiresAt.getTime() > now.getTime();
      const { patch } = transition(listing, live ? "published" : "expired", { now, lifetime: life });
      const moderation = listing.moderation;
      return {
        patch: { ...patch, pausedReason: null, adsEligible: live && adsEligibleOf({ status: "published", moderation }) },
        search: live ? "upsert" : null,
      };
    },
    now,
    "suspension resume",
  );
  return changes.map((change) => change.listing.id);
}

/** Ban (D14): published, paused and held listings are removed (decision per account); marked with the ban decision for a reversal. */
export async function removeListingsForBan(uid: string, decisionId: string, actorUid: string, now: Date): Promise<string[]> {
  const life = await lifetime();
  const listings = await listOwnerListingsByStatus(uid, [...BAN_STATUSES], SANCTION_LISTINGS_MAX);
  const changes = await changeListings(
    listings,
    (listing) => {
      if (!(BAN_STATUSES as readonly string[]).includes(listing.status)) return null;
      const { patch, effects } = transition(listing, "removed", { now, lifetime: life });
      return {
        patch: { ...patch, adsEligible: false, moderation: { ...listing.moderation, lastDecisionId: decisionId, reviewedBy: actorUid, reviewedAt: now } },
        search: effects.search,
      };
    },
    now,
    "ban removal",
  );
  return changes.map((change) => change.listing.id);
}

/**
 * A removed listing restored (appeal reversed, D16): published again with its own dates when its
 * expiry has not passed, else expired (the owner may renew it); never published before: back to
 * review. The lifecycle table has no `removed ->` exit but the purge: this is the reversal's own.
 */
export function unremovePatch(listing: ListingRecord, now: Date, life: Lifetime): ListingChange {
  const base = { version: listing.version + 1, updatedAt: now, pausedReason: null };
  if (!listing.publishedAt) return { patch: { ...base, status: "pending_review", purgeAt: null }, search: null };
  const live = listing.expiresAt !== undefined && listing.expiresAt.getTime() > now.getTime();
  if (!live) return { patch: { ...base, status: "expired", purgeAt: purgeAtFor(now, life) }, search: null };
  return { patch: { ...base, status: "published", purgeAt: purgeAtFor(listing.expiresAt ?? now, life) }, search: "upsert" };
}

/** Ban reversed: the listings this ban removed come back. */
export async function restoreBannedListings(uid: string, banDecisionId: string, actorUid: string, now: Date): Promise<string[]> {
  const life = await lifetime();
  const listings = (await listOwnerListingsByStatus(uid, ["removed"], SANCTION_LISTINGS_MAX)).filter((listing) => listing.moderation.lastDecisionId === banDecisionId);
  const changes = await changeListings(
    listings,
    (listing) => {
      if (listing.status !== "removed" || listing.moderation.lastDecisionId !== banDecisionId) return null;
      const change = unremovePatch(listing, now, life);
      const moderation = { ...listing.moderation, reviewedBy: actorUid, reviewedAt: now };
      const status = change.patch.status ?? listing.status;
      return { patch: { ...change.patch, moderation, adsEligible: adsEligibleOf({ status, moderation }) }, search: change.search };
    },
    now,
    "ban reversal",
  );
  return changes.map((change) => change.listing.id);
}

export interface LiftOptions {
  now?: Date;
  /** Lift only the suspension of this decision (an appeal reversal); undefined: whatever is due. */
  decisionId?: string;
  /** Who lifts it: the job ("system") or the reviewer of an appeal. */
  actor: { uid: string; role: "system" | "moderator" | "admin" };
  /** The appeal reversal also takes one strike off. */
  reduceStrikes?: boolean;
}

/**
 * Ends a suspension (lift-suspensions job, or an appeal reversal): the claim first (a failure
 * leaves the document, so the next run retries), then one transaction (suspension document
 * deleted, `suspended` -> `active`, `strikes.suspendedUntil` dropped), then the listings. False
 * when there is nothing to lift (no document, another decision's, or a ban since).
 */
export async function liftSuspension(uid: string, options: LiftOptions): Promise<boolean> {
  const now = options.now ?? new Date();
  const current = suspensionFromSnapshot(await suspensionRef(uid).get());
  void consume("firestore.reads", 1);
  if (!current || (options.decisionId && current.decisionId !== options.decisionId)) return false;
  const status = (await userRef(uid).get()).get("status");
  void consume("firestore.reads", 1);
  if (status !== "banned") await clearSuspendedClaim(uid);
  const lifted = await db().runTransaction(async (tx) => {
    const [suspensionSnap, userSnap, privateSnap] = await Promise.all([tx.get(suspensionRef(uid)), tx.get(userRef(uid)), tx.get(privateRef(uid))]);
    void consume("firestore.reads", 3);
    const suspension = suspensionFromSnapshot(suspensionSnap);
    if (!suspension || suspension.decisionId !== current.decisionId) return false;
    tx.delete(suspensionRef(uid));
    let writes = 1;
    if (userSnap.exists && userSnap.get("status") === "suspended") {
      tx.update(userRef(uid), { status: "active", updatedAt: Timestamp.fromDate(now) });
      writes += 1;
    }
    const account = privateFromSnapshot(privateSnap);
    if (account) {
      const level = options.reduceStrikes ? levelAfterReversal(account.strikes.level) : account.strikes.level;
      tx.update(privateRef(uid), { "strikes.level": level, "strikes.suspendedUntil": FieldValue.delete() });
      writes += 1;
    }
    void consume("firestore.writes", writes);
    return true;
  });
  if (!lifted) return false;
  const resumed = status === "banned" ? [] : await resumeModerationPaused(uid, now);
  await audit({
    actorUid: options.actor.uid,
    actorRole: options.actor.role,
    action: "user.unsuspend",
    target: { type: "user", id: uid },
    automated: options.actor.role === "system",
    reason: `${options.decisionId ? "appeal reversed" : "suspension ended"}; decision ${current.decisionId}; ${resumed.length} listing(s) resumed`,
    at: now,
  });
  return true;
}
