import type { Subcategory } from "@/config/categories";
import type { FieldIssue } from "@/lib/contracts/listings";
import type { ListingDoc } from "@/lib/db/schemas";

// Real-estate rules across fields (Agence pack design, phase-7/agence-immobiliere.md §1), on top of
// the declarative criteria. Pure, shared by the publish readiness and its tests.

/** Law 67-12 art. 20: the security deposit of a residential lease is at most two months' rent. */
export const DEPOSIT_MAX_MONTHS = 2;

type Candidate = Pick<ListingDoc, "attributes" | "price">;

export function realEstateIssues(listing: Candidate, subcategory: Subcategory): FieldIssue[] {
  if (subcategory.categoryId !== "immobilier") return [];
  const issues: FieldIssue[] = [];
  const { attributes } = listing;
  const deposit = attributes["deposit"];
  if (subcategory.priceUnit === "month" && typeof deposit === "number" && listing.price !== null && deposit > listing.price * DEPOSIT_MAX_MONTHS) {
    issues.push({ path: "attributes.deposit", code: "deposit_max" });
  }
  // Off-plan (VEFA, law 44-00): the buyer needs the building permit and the planned delivery.
  if (attributes["off-plan"] === true) {
    for (const id of ["building-permit", "delivery-year"]) {
      const value = attributes[id];
      if (value === undefined || (typeof value === "string" && value.trim() === "")) issues.push({ path: `attributes.${id}`, code: "criterion_required" });
    }
  }
  return issues;
}
