import "server-only";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import type { AuthContext } from "@/lib/auth/guards";
import { FLEET_MAX, type FleetResponse, type FleetSaveInput, type FleetSaveResponse } from "@/lib/contracts/listings";
import { listOwnerListingsOf, type ListingRecord } from "@/lib/db/repositories/listings";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { setRentalAvailability } from "./availability";
import { toOwnerSummary } from "./owner-view";

// Fleet planning of a car rental agency (rental pack §3, /pro/flotte): its rentals on offer in one
// grid, and the changes of a session saved at once, each like the listing's own calendar.

/** Rentals a fleet planning shows: on offer or about to be (drafts and ended ones stay in "Mes annonces"). */
const FLEET_STATUSES: readonly ListingRecord["status"][] = ["published", "paused", "pending_review"];

/** GET /api/pro/fleet: the agency's car rentals on offer, by title (Pro accounts only). */
export async function listFleet(auth: AuthContext, now = new Date()): Promise<FleetResponse> {
  if (auth.user.claims.role !== "pro") throw new HttpError(403, "forbidden", "fleet planning is for Pro agencies");
  const listings = await listOwnerListingsOf(auth.user.uid, RENTAL_SUBCATEGORY, FLEET_STATUSES, FLEET_MAX + 1);
  const vehicles = listings
    .slice(0, FLEET_MAX)
    .map((listing) => toOwnerSummary(listing, now))
    .sort((a, b) => a.title.localeCompare(b.title, "fr"));
  return { vehicles, truncated: listings.length > FLEET_MAX };
}

/** Changes saved at once (each its own transaction, index notice and revalidation). */
const FLEET_CONCURRENCY = 4;

/** PUT /api/pro/fleet: each change like a calendar save; one that fails leaves the others saved. */
export async function saveFleet(auth: AuthContext, input: FleetSaveInput, now = new Date()): Promise<FleetSaveResponse> {
  if (auth.user.claims.role !== "pro") throw new HttpError(403, "forbidden", "fleet planning is for Pro agencies");
  const results: FleetSaveResponse["results"] = new Array(input.changes.length);
  let next = 0;
  const worker = async () => {
    while (next < input.changes.length) {
      const index = next++;
      const { id, unavailable, since } = input.changes[index]!;
      try {
        results[index] = { id, rental: await setRentalAvailability(auth, id, { unavailable, since }, now) };
      } catch (error) {
        const code = error instanceof HttpError ? error.code : "internal";
        if (!(error instanceof HttpError)) logger.warn({ err: (error as Error).message, listingId: id }, "fleet change failed");
        results[index] = { id, error: code === "conflict" || code === "not_found" || code === "invalid_body" ? code : "failed" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, input.changes.length) }, worker));
  return { results };
}
