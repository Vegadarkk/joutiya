import "server-only";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { requireOwner, type AuthContext } from "@/lib/auth/guards";
import type { RentalAvailability, RentalAvailabilityInput } from "@/lib/contracts/listings";
import { getListing, getListingTx, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { notifySearchIndex } from "@/lib/search/queue";
import { moroccoToday, normalizePeriods, type RentalPeriod } from "./rental-availability";
import { revalidateListingPaths } from "./revalidate";

// A car rental's availability (rental pack §3): the agency replaces its blocked periods, or saves
// them unchanged to confirm they are up to date. No text, so no moderation pass; the listing is
// re-indexed (search by dates) and its public page revalidated.

export function rentalAvailabilityOf(listing: Pick<ListingRecord, "rental">): RentalAvailability {
  return { unavailable: listing.rental?.unavailable ?? [], updatedAt: listing.rental?.updatedAt.toISOString() ?? null };
}

/** Statuses the owner still manages (the wizard's, see EDITABLE_STATUSES in service.ts). */
const CALENDAR_STATUSES: readonly ListingRecord["status"][] = ["draft", "pending_review", "published", "paused", "expired", "rejected"];

class AvailabilityChangedError extends Error {}

export async function setRentalAvailability(auth: AuthContext, id: string, input: RentalAvailabilityInput, now = new Date()): Promise<RentalAvailability> {
  const listing = await getListing(id);
  if (!listing) throw notFound();
  requireOwner(auth, listing);
  if (listing.subcategoryId !== RENTAL_SUBCATEGORY || !CALENDAR_STATUSES.includes(listing.status)) throw new HttpError(409, "conflict", "not an editable car rental");
  const normalized = normalizePeriods(input.unavailable, moroccoToday(now));
  if ("problem" in normalized) throw new HttpError(422, "invalid_body", undefined, { details: [{ path: "unavailable", code: normalized.problem }] });
  const rental = { unavailable: normalized.periods, updatedAt: now };
  let indexed = false;
  try {
    await db().runTransaction(async (tx) => {
      const current = await getListingTx(tx, id);
      if (!current) throw notFound();
      if ((current.rental?.updatedAt.toISOString() ?? null) !== input.since) throw new AvailabilityChangedError();
      const version = current.version + 1;
      const patch: ListingFieldPatch = { rental, version, updatedAt: now };
      updateListingTx(tx, id, patch);
      indexed = current.status === "published";
      if (indexed) enqueueSearchOutboxTx(tx, id, "upsert", version, now);
    });
  } catch (error) {
    if (error instanceof AvailabilityChangedError) throw new HttpError(409, "conflict", "availability changed meanwhile, reload it");
    throw error;
  }
  if (indexed) await notifySearchIndex([id]);
  if (listing.slugId) revalidateListingPaths({ slugId: listing.slugId });
  return rentalAvailabilityOf({ rental });
}

/**
 * A booking request accepted with its days blocked (rental pack §6): the period joins the listing's
 * blocked ones, merged, in one transaction (no `since` lock: the agency's planning page then gets
 * its 409 and reloads). False when the days cannot be written: no longer the caller's car rental,
 * or more than RENTAL_PERIODS_MAX periods once merged.
 */
export async function blockRentalDates(actor: Pick<AuthContext["user"], "uid" | "claims">, id: string, period: RentalPeriod, now = new Date()): Promise<boolean> {
  let indexed = false;
  let slugId: string | undefined;
  const written = await db().runTransaction(async (tx) => {
    const current = await getListingTx(tx, id);
    if (!current || current.subcategoryId !== RENTAL_SUBCATEGORY || !CALENDAR_STATUSES.includes(current.status)) return false;
    if (current.ownerUid !== actor.uid && !(current.proId && current.proId === actor.claims.proId)) return false;
    const normalized = normalizePeriods([...(current.rental?.unavailable ?? []), period], moroccoToday(now));
    if ("problem" in normalized) return false;
    const version = current.version + 1;
    updateListingTx(tx, id, { rental: { unavailable: normalized.periods, updatedAt: now }, version, updatedAt: now });
    indexed = current.status === "published";
    if (indexed) enqueueSearchOutboxTx(tx, id, "upsert", version, now);
    slugId = current.slugId;
    return true;
  });
  if (indexed) await notifySearchIndex([id]);
  if (slugId) revalidateListingPaths({ slugId });
  return written;
}
