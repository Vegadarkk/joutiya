import "server-only";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { requireOwner, type AuthContext } from "@/lib/auth/guards";
import type { RentalAvailability, RentalAvailabilityInput } from "@/lib/contracts/listings";
import { getListing, getListingTx, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { notifySearchIndex } from "@/lib/search/queue";
import { moroccoToday, normalizePeriods } from "./rental-availability";
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
