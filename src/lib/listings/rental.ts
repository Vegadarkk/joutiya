import { RENTAL_SUBCATEGORY, type Subcategory } from "@/config/categories";
import type { FieldIssue } from "@/lib/contracts/listings";
import type { ListingDoc } from "@/lib/db/schemas";

// Car rental rules across fields (rental pack, location-voitures/location-voitures.md §2), on top of
// the declarative criteria. Pure, shared by the publish readiness and its tests.

type Candidate = Pick<ListingDoc, "attributes" | "price">;

/** Day price of a rental for `days` days: the longest-term rate the agency declared that applies. */
export function rentalDayRate(attributes: Candidate["attributes"], price: number, days: number): number {
  const week = attributes["rate-7-days"];
  const month = attributes["rate-30-days"];
  if (days >= 30 && typeof month === "number") return month;
  if (days >= 7 && typeof week === "number") return week;
  return price;
}

export function rentalIssues(listing: Candidate, subcategory: Subcategory): FieldIssue[] {
  if (subcategory.id !== RENTAL_SUBCATEGORY) return [];
  const issues: FieldIssue[] = [];
  const { attributes, price } = listing;
  const week = attributes["rate-7-days"];
  const month = attributes["rate-30-days"];
  // Long-term rates are discounts: never above the day price, a month never above a week.
  if (typeof week === "number" && price !== null && week > price) issues.push({ path: "attributes.rate-7-days", code: "rental_rate_max" });
  const monthCap = typeof week === "number" ? week : price;
  if (typeof month === "number" && monthCap !== null && month > monthCap) issues.push({ path: "attributes.rate-30-days", code: "rental_rate_max" });
  // A limited mileage needs its daily allowance, or the renter cannot compare.
  if (attributes["mileage-policy"] === "limite" && attributes["km-per-day"] === undefined) issues.push({ path: "attributes.km-per-day", code: "criterion_required" });
  return issues;
}
