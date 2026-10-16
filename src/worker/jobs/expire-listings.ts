import { listingLifetime } from "@/config/pricing";
import { audit } from "@/lib/audit";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { EXPIRING_STATUSES, applyListingTransition, listListingsToExpire, type ListingCursor } from "@/lib/db/repositories/retention";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { getLegalConfig } from "@/lib/legal/config";
import { transition, type Lifetime } from "@/lib/listings/lifecycle";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { recipientCache, type ListingRecipient } from "@/lib/mail/recipients";
import { isDegraded } from "@/lib/quota";

// Nightly at 02:30 UTC (design D16): published (and paused) listings whose expiresAt passed go
// `expired` through the lifecycle transition (version + 1, purgeAt = now + listingPurgeMonths,
// searchOutbox delete, audit), one transaction each that re-checks the listing, then the seller
// gets the listingExpired mail. The public page follows within its ISR window (300 s):
// revalidatePath does not work outside a Next request. Bounded per night; the rest waits a day.
// The write quota is re-checked before each listing (a Valkey read), and the first RESOURCE_EXHAUSTED
// ends the run: the SDK would otherwise back off for minutes on every remaining listing while the
// system queue (reminders, purges, backup) waits behind this job.

export const EXPIRE_BATCH = 200;
export const EXPIRE_PAGES = 10;

/** gRPC RESOURCE_EXHAUSTED: Spark refuses writes until its daily reset. */
const RESOURCE_EXHAUSTED = 8;

export interface ExpireResult {
  expired: number;
  mailed: number;
  /** Changed since the query (renewed, sold, removed): left alone. */
  skipped: number;
  failed: number;
}

type Recipients = (uid: string) => Promise<ListingRecipient | null>;

function stillExpiring(listing: ListingRecord, now: Date): boolean {
  return EXPIRING_STATUSES.includes(listing.status) && listing.expiresAt !== undefined && listing.expiresAt.getTime() <= now.getTime();
}

async function expireOne(id: string, now: Date, lifetime: Lifetime): Promise<{ listing: ListingRecord; audit: string | null } | null> {
  let auditAction: string | null = null;
  const listing = await applyListingTransition(
    id,
    (current) => {
      if (!stillExpiring(current, now)) return null;
      const { patch, effects } = transition(current, "expired", { now, lifetime });
      auditAction = effects.audit;
      return { patch, search: effects.search };
    },
    now,
  );
  return listing ? { listing, audit: auditAction } : null;
}

/** listingExpired mail; a failure is logged, never retried here (the state is written). */
async function notify(listing: ListingRecord, recipients: Recipients): Promise<boolean> {
  try {
    const to = await recipients(listing.ownerUid);
    if (!to || !listing.purgeAt) return false;
    await sendMail({
      template: "listingExpired",
      locale: to.locale,
      to: to.email,
      data: { displayName: to.displayName, title: listing.title, purgeAt: listing.purgeAt.toISOString() },
      priority: "transactional",
      idempotencyKey: `listingExpired-${listing.id}-${listing.version}`,
    });
    return true;
  } catch (error) {
    logger.warn({ listingId: listing.id, err: (error as Error).message }, "listing expiry mail failed");
    return false;
  }
}

export async function expireListings(now = new Date()): Promise<ExpireResult> {
  const result: ExpireResult = { expired: 0, mailed: 0, skipped: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("expire-listings skipped: Firebase not configured");
    return result;
  }
  if (await isDegraded("firestore.writes")) {
    logger.warn("expire-listings deferred: Firestore write quota degraded");
    return result;
  }
  const lifetime = listingLifetime(await getLegalConfig());
  const recipients = recipientCache();
  let cursor: ListingCursor | undefined;
  pages: for (let pages = 0; pages < EXPIRE_PAGES; pages += 1) {
    const page = await listListingsToExpire(now, EXPIRE_BATCH, cursor);
    for (const candidate of page.listings) {
      if (await isDegraded("firestore.writes")) {
        logger.warn({ ...result }, "expire-listings stopped: Firestore write quota degraded");
        break pages;
      }
      try {
        const done = await expireOne(candidate.id, now, lifetime);
        if (!done) {
          result.skipped += 1;
          continue;
        }
        result.expired += 1;
        if (done.audit) await audit({ actorUid: "system", actorRole: "system", action: done.audit, target: { type: "listing", id: candidate.id }, automated: true, at: now });
        if (await notify(done.listing, recipients)) result.mailed += 1;
      } catch (error) {
        result.failed += 1;
        logger.warn({ listingId: candidate.id, err: (error as Error).message }, "listing not expired");
        if ((error as { code?: unknown }).code === RESOURCE_EXHAUSTED) break pages;
      }
    }
    if (!page.next || page.read < EXPIRE_BATCH) break;
    cursor = page.next;
  }
  logger.info({ ...result }, "expire-listings");
  return result;
}
