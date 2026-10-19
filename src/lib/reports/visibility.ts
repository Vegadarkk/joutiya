import "server-only";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { audit } from "@/lib/audit";
import { getListingTx, listPublishedByOwner, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { COLLECTIONS, userStatusSchema } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { PUBLIC_STATES } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { hideMessage, unhideMessage } from "@/lib/messaging";
import { consume } from "@/lib/quota";
import { notifySearchIndex } from "@/lib/search/queue";
import { listTargetReports } from "./repository";
import type { StrongSignal } from "./rules";
import { splitMessageId, type TargetRef } from "./target-key";

// Visibility of reported content (design D11, D13). A strong signal hides at once: a listing gets
// `moderation.hiddenBy` (search outbox + fast lane, ISR revalidation; the public page and the index
// treat it as unavailable), an account becomes `restricted` and each of its published listings is
// hidden, a message is replaced by HIDDEN_MARKER (messaging lot's hideMessage; messaging reaches this
// module only lazily, so the static import makes no cycle). `unhideTarget` undoes it (restore,
// D13). Every change bumps the listing version: a concurrent owner save then retries instead of
// writing back a stale `moderation`.

/** Listings hidden with a restricted account (one transaction each, D11 "<= 50 writes"). */
export const USER_HIDE_LISTINGS_MAX = 50;
/** Listings looked at when an account is restored. */
const USER_RESTORE_LISTINGS_MAX = 100;

const hasPublicPage = (listing: Pick<ListingRecord, "status">) => (PUBLIC_STATES as readonly string[]).includes(listing.status);

/** adsEligible (§5): published, no open report, not hidden. */
export function adsEligibleOf(listing: Pick<ListingRecord, "status" | "moderation">): boolean {
  return listing.status === "published" && listing.moderation.openReports === 0 && !listing.moderation.hiddenBy;
}

/** The patch hiding a listing, or null when it is hidden already (the first report keeps the credit). */
export function hidePatch(listing: ListingRecord, signal: StrongSignal, reportId: string, now: Date): (ListingFieldPatch & { version: number }) | null {
  if (listing.moderation.hiddenBy) return null;
  return {
    moderation: { ...listing.moderation, hiddenBy: { reportId, signal, at: now } },
    adsEligible: false,
    version: listing.version + 1,
    updatedAt: now,
  };
}

/** The patch showing a hidden listing again, or null when it is not hidden. */
export function unhidePatch(listing: ListingRecord, now: Date): (ListingFieldPatch & { version: number }) | null {
  if (!listing.moderation.hiddenBy) return null;
  const { hiddenBy: _hidden, ...moderation } = listing.moderation;
  return { moderation, adsEligible: adsEligibleOf({ status: listing.status, moderation }), version: listing.version + 1, updatedAt: now };
}

/**
 * Writes a visibility patch (hidePatch, unhidePatch) and, for a published listing, its search outbox
 * entry inside the caller's transaction. True when the index must hear of it (notifySearchIndex).
 */
export function writeVisibilityTx(tx: Transaction, listing: ListingRecord, patch: ListingFieldPatch & { version: number }, op: "delete" | "upsert", now: Date): boolean {
  updateListingTx(tx, listing.id, patch);
  if (listing.status !== "published") return false;
  enqueueSearchOutboxTx(tx, listing.id, op, patch.version, now);
  return true;
}

export interface VisibilityChange {
  listing: ListingRecord;
  /** A search outbox entry was written. */
  search: boolean;
  hidden: boolean;
  reason: string;
}

/** After the commit: index fast lane, ISR revalidation, audit (never throws). */
export async function afterVisibilityChange(changes: readonly VisibilityChange[], now: Date): Promise<void> {
  if (changes.length === 0) return;
  await notifySearchIndex(changes.filter((change) => change.search).map((change) => change.listing.id));
  for (const change of changes) {
    if (hasPublicPage(change.listing)) revalidateListingPaths({ slugId: change.listing.slugId, publicId: change.listing.sellerPublicId });
    await audit({
      actorUid: "system",
      actorRole: "system",
      action: change.hidden ? "listing.hide" : "listing.unhide",
      target: { type: "listing", id: change.listing.id },
      automated: true,
      reason: change.reason,
      at: now,
    });
  }
}

async function setListingHidden(listingId: string, hide: { signal: StrongSignal; reportId: string } | null, now: Date): Promise<VisibilityChange | null> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, listingId);
    if (!listing) return null;
    const patch = hide ? hidePatch(listing, hide.signal, hide.reportId, now) : unhidePatch(listing, now);
    if (!patch) return null;
    const search = writeVisibilityTx(tx, listing, patch, hide ? "delete" : "upsert", now);
    return { listing, search, hidden: hide !== null, reason: hide ? `report ${hide.reportId} (${hide.signal})` : `restored (report ${listing.moderation.hiddenBy?.reportId ?? "?"})` };
  });
}

const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);

/** active <-> restricted; other statuses (suspended, banned, closed) are the decisions' own. */
async function setRestricted(uid: string, restricted: boolean, now: Date): Promise<{ changed: boolean; publicId: string | null }> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(userRef(uid));
    void consume("firestore.reads", 1);
    if (!snapshot.exists) return { changed: false, publicId: null };
    const status = userStatusSchema.safeParse(snapshot.get("status"));
    const publicId = typeof snapshot.get("publicId") === "string" ? (snapshot.get("publicId") as string) : null;
    const from = restricted ? "active" : "restricted";
    if (!status.success || status.data !== from) return { changed: false, publicId };
    tx.update(userRef(uid), { status: restricted ? "restricted" : "active", updatedAt: Timestamp.fromDate(now) });
    void consume("firestore.writes", 1);
    return { changed: true, publicId };
  });
}

async function hideUser(uid: string, signal: StrongSignal, reportId: string, now: Date): Promise<boolean> {
  const account = await setRestricted(uid, true, now);
  const listings = await listPublishedByOwner(uid, USER_HIDE_LISTINGS_MAX);
  const changes: VisibilityChange[] = [];
  for (const listing of listings) {
    const change = await setListingHidden(listing.id, { signal, reportId }, now);
    if (change) changes.push(change);
  }
  await afterVisibilityChange(changes, now);
  if (account.publicId) revalidateListingPaths({ publicId: account.publicId });
  if (account.changed || changes.length > 0) {
    await audit({ actorUid: "system", actorRole: "system", action: "user.restrict", target: { type: "user", id: uid }, automated: true, reason: `report ${reportId} (${signal}); ${changes.length} listing(s) hidden`, at: now });
  }
  return account.changed || changes.length > 0;
}

async function unhideUser(uid: string, now: Date): Promise<boolean> {
  const account = await setRestricted(uid, false, now);
  // Only the listings hidden because of a report on this account; a listing's own report keeps it hidden.
  const reportIds = new Set((await listTargetReports({ type: "user", id: uid })).map((report) => report.id));
  const listings = (await listPublishedByOwner(uid, USER_RESTORE_LISTINGS_MAX)).filter((listing) => listing.moderation.hiddenBy && reportIds.has(listing.moderation.hiddenBy.reportId));
  const changes: VisibilityChange[] = [];
  for (const listing of listings) {
    const change = await setListingHidden(listing.id, null, now);
    if (change) changes.push(change);
  }
  await afterVisibilityChange(changes, now);
  if (account.publicId) revalidateListingPaths({ publicId: account.publicId });
  if (account.changed || changes.length > 0) {
    await audit({ actorUid: "system", actorRole: "system", action: "user.unrestrict", target: { type: "user", id: uid }, automated: true, reason: `${changes.length} listing(s) shown again`, at: now });
  }
  return account.changed || changes.length > 0;
}

/**
 * Hides the target of a report on a strong signal (D11). True when something changed (false: hidden
 * already, gone, or a type that cannot be hidden yet). The report's `hidden` flag is the caller's.
 */
export async function hideTarget(target: TargetRef, signal: StrongSignal, reportId: string, now = new Date()): Promise<boolean> {
  switch (target.type) {
    case "listing": {
      const change = await setListingHidden(target.id, { signal, reportId }, now);
      if (change) await afterVisibilityChange([change], now);
      return change !== null;
    }
    case "user":
      return hideUser(target.id, signal, reportId, now);
    case "message": {
      const ids = splitMessageId(target.id);
      return ids ? hideMessage(ids.cid, ids.mid, `report:${reportId}`) : false;
    }
    case "pro":
      logger.warn({ target: target.type }, "reports: shop targets cannot be hidden before phase 7");
      return false;
  }
}

/** Shows a hidden target again (restore, D13). True when something changed. */
export async function unhideTarget(target: TargetRef, now = new Date()): Promise<boolean> {
  switch (target.type) {
    case "listing": {
      const change = await setListingHidden(target.id, null, now);
      if (change) await afterVisibilityChange([change], now);
      return change !== null;
    }
    case "user":
      return unhideUser(target.id, now);
    case "message": {
      const ids = splitMessageId(target.id);
      return ids ? unhideMessage(ids.cid, ids.mid) : false;
    }
    case "pro":
      return false;
  }
}
