import "server-only";
import { listingLifetime } from "@/config/pricing";
import type { Locale } from "@/config/site";
import { LOCALES } from "@/config/site";
import { audit } from "@/lib/audit";
import { requireActiveAccount, requireUser } from "@/lib/auth/guards";
import { jsonResponse, withDevice } from "@/lib/auth/respond";
import { closeAccountSchema, type CloseAccountResponse } from "@/lib/contracts/account";
import { getListingTx, listOwnerListingsByStatus, updateListingTx, type ListingRecord } from "@/lib/db/repositories/listings";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { bumpFavoriteStat } from "@/lib/favorites/ids-cache";
import { auth, db } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { getLegalConfig } from "@/lib/legal/config";
import { transition, type Lifetime } from "@/lib/listings/lifecycle";
import { storefrontSegment } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { closeAccountConversations, publishRevoked } from "@/lib/messaging";
import { anonymizeAuthoredReviews } from "@/lib/reviews/repository";
import { assertQuotas } from "@/lib/quota/gate";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { notifySearchIndex } from "@/lib/search/queue";
import { clearSessionCookies } from "@/lib/security/cookies";
import { deleteAllFavorites, deleteAllSavedSearches, markAccountClosed, readBillingState, readClosureAccount } from "./repository";
import { CLOSURE_LISTING_STATUSES, closureBlocker, closurePurgeAt, isRecentSignIn } from "./rules";

// POST /api/account/close (phase 5 design D26, lot L7; AF §5 UserPrivate, §6 "La clôture passe par
// l'API", §7 retention table). The signed-in member closes the account after a recent sign-in.
// Firestore first, Auth last: a failure half-way answers an error while the session still works,
// and the retry (idempotent: the dates of the first attempt stay) finishes the job.
//  1. Pro refusal (spec silent, owner follow-up): a subscription that still renews, or purchased
//     credits left, answer 409 before anything changes;
//  2. users/{uid}/private/account: closedAt, purgeAt (+1 year), identityPurgeAt (+5 years);
//     users/{uid}.status "closed" (a banned account stays banned);
//  3. live, paused, held, sold and expired listings removed (search outbox delete, fast lane, ISR),
//     the shop's storefront page revalidated (hidden: its owner is closed);
//  4. conversations marked accountClosed (the other participant reads, nobody writes);
//  5. favorites and saved searches deleted; the reviews the member wrote lose the author's name
//     (vitrine-avis §3: "Ancien membre"), the storefronts showing them revalidated;
//  6. audit entry, then the Auth user disabled and its refresh tokens revoked, open streams closed,
//     confirmation mail (transactional).
// Untouched: reports, decisions and appeals, authority requests, suspensions, strikes, legal holds,
// the emailIndex entry and connection logs (they keep their own clocks; the purge is retention-purge's).

/** Pages of listings read per closure (each listing in its own transaction). */
const LISTING_PAGE = 100;
const LISTING_PAGES = 10;

export interface ClosureResult {
  closedAt: Date;
  purgeAt: Date;
  identityPurgeAt: Date;
  /** A previous attempt had already closed the documents. */
  already: boolean;
  listings: number;
  conversations: number;
  favorites: number;
  savedSearches: number;
}

async function lifetime(): Promise<Lifetime> {
  return listingLifetime(await getLegalConfig());
}

/** One listing removed in its own transaction (re-read; left alone when its status changed meanwhile). */
async function removeListing(id: string, life: Lifetime, now: Date): Promise<{ listing: ListingRecord; search: boolean } | null> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, id);
    if (!listing || !CLOSURE_LISTING_STATUSES.includes(listing.status)) return null;
    const { patch, effects } = transition(listing, "removed", { now, lifetime: life });
    const purgeAt = closurePurgeAt(listing.purgeAt, patch.purgeAt ?? now);
    updateListingTx(tx, id, { ...patch, purgeAt, adsEligible: false });
    if (effects.search) enqueueSearchOutboxTx(tx, id, effects.search, patch.version, now);
    return { listing, search: effects.search !== null };
  });
}

/**
 * Every listing a public page, the search or a renewal could still show goes to `removed`, its
 * purge clock never pushed back (removal + 12 months, or the earlier date it had). Throws when one
 * could not be removed: the account must not close with a listing left online.
 */
async function removeListings(uid: string, publicId: string, now: Date): Promise<number> {
  const life = await lifetime();
  const removed: { listing: ListingRecord; search: boolean }[] = [];
  let failed = 0;
  for (let page = 0; page < LISTING_PAGES; page += 1) {
    const listings = await listOwnerListingsByStatus(uid, CLOSURE_LISTING_STATUSES, LISTING_PAGE);
    let progress = 0;
    for (const listing of listings) {
      try {
        const change = await removeListing(listing.id, life, now);
        if (change) {
          removed.push(change);
          progress += 1;
        }
      } catch (error) {
        failed += 1;
        logger.error({ listingId: listing.id, err: (error as Error).message }, "account closure: listing not removed");
      }
    }
    if (listings.length < LISTING_PAGE || progress === 0) break;
  }
  try {
    await notifySearchIndex(removed.filter((change) => change.search).map((change) => change.listing.id));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "account closure: search fast lane failed");
  }
  for (const change of removed) revalidateListingPaths({ slugId: change.listing.slugId });
  if (publicId) revalidateListingPaths({ publicId });
  if (failed > 0) throw new HttpError(503, "unavailable", "some listings could not be removed, retry");
  return removed.length;
}

/**
 * The shop's storefront leaves the ISR cache at once: its loader already answers 404 for a closed
 * owner, the cached page would otherwise stay up to its `revalidate`.
 */
async function revalidateStorefront(proId: string): Promise<void> {
  try {
    const profile = await getProProfile(proId);
    if (profile) revalidateListingPaths({ shopSegment: storefrontSegment(profile.slug, proId) });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "account closure: storefront not revalidated");
  }
}

/** Favorites deleted, their listings' counters lowered (best effort: a counter is only a statistic). */
async function deleteFavorites(uid: string): Promise<number> {
  const ids = await deleteAllFavorites(uid);
  for (const listingId of ids) await bumpFavoriteStat(listingId, -1).catch(() => undefined);
  return ids.length;
}

/** Best effort: a failure is logged, the retry of the closure runs it again. */
async function anonymizeReviews(uid: string, now: Date): Promise<void> {
  try {
    for (const publicId of await anonymizeAuthoredReviews(uid, now)) revalidateListingPaths({ publicId });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "account closure: reviews not anonymized");
  }
}

const localeOf = (value: string): Locale => ((LOCALES as readonly string[]).includes(value) ? (value as Locale) : "fr");

/**
 * Closes the account of `uid` (see the header). The caller has checked the session, the recent
 * sign-in and the limits. 409 `pro_subscription_active` / `wallet_not_empty` before any change.
 */
export async function closeAccount(uid: string, options: { now?: Date; ip?: string; actorRole?: "individual" | "pro" } = {}): Promise<ClosureResult> {
  const now = options.now ?? new Date();
  const account = await readClosureAccount(uid);
  if (!account.closedAt) {
    const blocker = closureBlocker(await readBillingState(uid, account.proId));
    if (blocker) throw new HttpError(409, blocker);
  }
  const mark = await markAccountClosed(uid, now);
  const listings = await removeListings(uid, account.publicId, now);
  if (account.proId) await revalidateStorefront(account.proId);
  const conversations = await closeAccountConversations(uid, now);
  const favorites = await deleteFavorites(uid);
  const savedSearches = await deleteAllSavedSearches(uid);
  await anonymizeReviews(uid, now);

  await audit({
    actorUid: uid,
    actorRole: options.actorRole ?? "individual",
    action: "account.close",
    target: { type: "user", id: uid },
    automated: false,
    reason: `${mark.already ? "retry; " : ""}${listings} listing(s) removed, ${conversations} conversation(s) read-only, ${favorites} favorite(s) and ${savedSearches} saved search(es) deleted`,
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });
  // Auth last: from here the session and every other one of the account stop working.
  await auth().updateUser(uid, { disabled: true });
  await auth().revokeRefreshTokens(uid);
  await publishRevoked(uid);

  if (account.email) {
    try {
      await sendMail({
        template: "accountClosed",
        locale: localeOf(account.locale),
        to: account.email,
        data: { displayName: account.displayName, closedAt: mark.closedAt.toISOString(), purgeAt: mark.purgeAt.toISOString() },
        priority: "transactional",
        idempotencyKey: `accountClosed-${uid}`,
      });
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "account closure: confirmation mail not sent");
    }
  }
  return { closedAt: mark.closedAt, purgeAt: mark.purgeAt, identityPurgeAt: mark.identityPurgeAt, already: mark.already, listings, conversations, favorites, savedSearches };
}

/** POST /api/account/close: session, CSRF, limit, recent sign-in, then closeAccount; the session cookies are cleared. */
export async function handleCloseAccount(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true, allowSuspended: true });
  await readJson(request, closeAccountSchema);
  const { uid } = context.user;
  await enforceLimit("account.close.uid", uid);
  const now = new Date();
  if (!isRecentSignIn(context.user.authTime, now)) throw new HttpError(403, "recent_auth_required");
  const record = await requireActiveAccount(uid);
  await assertQuotas(["firestore.writes"]);
  const result = await closeAccount(uid, { now, ip: requestIdentity(request.headers).ip, actorRole: record.claims?.role === "pro" ? "pro" : "individual" });
  const body: CloseAccountResponse = { status: "closed", closedAt: result.closedAt.toISOString(), purgeAt: result.purgeAt.toISOString() };
  const response = jsonResponse(body);
  clearSessionCookies(response);
  return withDevice(response, request);
}
