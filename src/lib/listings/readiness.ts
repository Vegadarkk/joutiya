import { criteriaSchema, criterionApplies, subcategoryById, type Subcategory } from "@/config/categories";
import { listingQuotas, type Seller } from "@/config/pricing";
import { cityBySlug } from "@/config/regions";
import { descriptionSchema, titleSchema, type FieldIssue } from "@/lib/contracts/listings";
import type { ListingDoc } from "@/lib/db/schemas";
import { realEstateIssues } from "./real-estate";

// Publish readiness (architecture §7 step 1, design D4/D8): the hard blockers a listing must clear
// before the pre-moderation runs. Pure: config and contracts only, so the matrix is unit-tested on
// the real categories and regions data. Codes are the wizard's validation keys (messages
// Listing.validation.*), so a server blocker reads like a client-side error under the same field.

export const READINESS_CODES = [
  "title_min",
  "title_max",
  "description_min",
  "description_max",
  "category_required",
  "subcategory_required",
  "subcategory_mismatch",
  "pro_only",
  "criterion_pro_only",
  "criterion_required",
  "criterion_invalid",
  "condition_required",
  "price_required",
  "price_invalid",
  "deposit_max",
  "donation_not_allowed",
  "donation_price",
  "city_required",
  "region_mismatch",
  "photos_required",
  "photos_max",
  "phone_required",
  "messaging_only",
  "unknown",
] as const;
export type ReadinessCode = (typeof READINESS_CODES)[number];

export interface SellerFacts {
  seller: Seller;
  phoneVerified: boolean;
}

type Candidate = Pick<ListingDoc, "title" | "description" | "categoryId" | "subcategoryId" | "attributes" | "condition" | "price" | "isDonation" | "location" | "photos" | "contact">;

const issue = (path: string, code: ReadinessCode): FieldIssue => ({ path, code });

function textIssues(path: "title" | "description", value: string, schema: typeof titleSchema | typeof descriptionSchema): FieldIssue[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  const codes = new Set<ReadinessCode>();
  for (const problem of parsed.error.issues) {
    if (problem.code === "too_small") codes.add(`${path}_min`);
    else if (problem.code === "too_big") codes.add(`${path}_max`);
    else codes.add("unknown");
  }
  return [...codes].map((code) => issue(path, code));
}

function treeIssues(listing: Candidate, seller: Seller): { issues: FieldIssue[]; subcategory: Subcategory | undefined } {
  const issues: FieldIssue[] = [];
  if (!listing.categoryId) issues.push(issue("categoryId", "category_required"));
  if (!listing.subcategoryId) {
    issues.push(issue("subcategoryId", "subcategory_required"));
    return { issues, subcategory: undefined };
  }
  const subcategory = subcategoryById(listing.subcategoryId);
  if (!subcategory) {
    issues.push(issue("subcategoryId", "unknown"));
    return { issues, subcategory: undefined };
  }
  if (listing.categoryId && subcategory.categoryId !== listing.categoryId) issues.push(issue("subcategoryId", "subcategory_mismatch"));
  if (subcategory.proOnly && seller.type !== "pro") issues.push(issue("subcategoryId", "pro_only"));
  return { issues, subcategory };
}

function attributeIssues(attributes: Candidate["attributes"], subcategory: Subcategory, seller: Seller): FieldIssue[] {
  const parsed = criteriaSchema(subcategory.id, seller.type).safeParse(attributes);
  if (parsed.success) return [];
  const seen = new Map<string, ReadinessCode>();
  for (const problem of parsed.error.issues) {
    const key = String(problem.path[0] ?? "");
    const path = key ? `attributes.${key}` : "attributes";
    if (problem.code === "unrecognized_keys") {
      for (const unknown of problem.keys) seen.set(`attributes.${unknown}`, "unknown");
      continue;
    }
    // Zod reports a missing field as invalid_type (or invalid_value for enums): the input tells.
    const value = attributes[key];
    const required = subcategory.criteria.find((criterion) => criterion.id === key)?.required === true;
    const missing = value === undefined || (required && typeof value === "string" && value.trim() === "");
    const code: ReadinessCode = missing ? "criterion_required" : "criterion_invalid";
    if (!seen.has(path) || code === "criterion_required") seen.set(path, code);
  }
  return [...seen].map(([path, code]) => issue(path, code));
}

/** Pro-only criteria (stock reference) and dependent ones (a warranty's duration needs a warranty). */
function dossierIssues(attributes: Candidate["attributes"], subcategory: Subcategory, seller: Seller): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const criterion of subcategory.criteria) {
    if (attributes[criterion.id] === undefined) continue;
    if (criterion.proOnly && seller.type !== "pro") issues.push(issue(`attributes.${criterion.id}`, "criterion_pro_only"));
    else if (!criterionApplies(criterion, attributes)) issues.push(issue(`attributes.${criterion.id}`, "criterion_invalid"));
  }
  return issues;
}

function priceIssues(listing: Candidate, subcategory: Subcategory): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (listing.isDonation) {
    if (!subcategory.donationAllowed) issues.push(issue("isDonation", "donation_not_allowed"));
    if (listing.price !== null && listing.price !== 0) issues.push(issue("price", "donation_price"));
    return issues;
  }
  if (listing.price === null) {
    if (!subcategory.priceOptional) issues.push(issue("price", "price_required"));
  } else if (listing.price < 1) {
    issues.push(issue("price", "price_invalid"));
  }
  return issues;
}

function locationIssues(listing: Candidate): FieldIssue[] {
  if (!listing.location) return [issue("location", "city_required")];
  const city = cityBySlug(listing.location.citySlug);
  if (!city) return [issue("location.citySlug", "unknown")];
  if (city.regionCode !== listing.location.regionCode) return [issue("location.regionCode", "region_mismatch")];
  return [];
}

/**
 * Every blocker of a listing about to be published, by field. Empty = ready for the pre-moderation
 * (screening.ts), which may add its own blockers (phone number in the text, prohibited object).
 */
export function assessReadiness(listing: Candidate, facts: SellerFacts): FieldIssue[] {
  const issues: FieldIssue[] = [];
  issues.push(...textIssues("title", listing.title, titleSchema));
  issues.push(...textIssues("description", listing.description, descriptionSchema));
  const tree = treeIssues(listing, facts.seller);
  issues.push(...tree.issues);
  if (tree.subcategory) {
    issues.push(...attributeIssues(listing.attributes, tree.subcategory, facts.seller));
    issues.push(...dossierIssues(listing.attributes, tree.subcategory, facts.seller));
    issues.push(...realEstateIssues(listing, tree.subcategory));
    if (tree.subcategory.condition === "required" && !listing.condition) issues.push(issue("condition", "condition_required"));
    issues.push(...priceIssues(listing, tree.subcategory));
  }
  issues.push(...locationIssues(listing));
  const quotas = listingQuotas(facts.seller);
  if (listing.photos.length === 0) issues.push(issue("photos", "photos_required"));
  else if (listing.photos.length > quotas.photosPerListing) issues.push(issue("photos", "photos_max"));
  if (tree.subcategory?.adultsOnly) {
    // Adults-only goods: messaging only (the buyer's 18+ confirmation is asked there).
    if (listing.contact.showPhone) issues.push(issue("contact.showPhone", "messaging_only"));
    if (listing.contact.whatsapp) issues.push(issue("contact.whatsapp", "messaging_only"));
  } else if ((listing.contact.showPhone || listing.contact.whatsapp) && !facts.phoneVerified) {
    if (listing.contact.showPhone) issues.push(issue("contact.showPhone", "phone_required"));
    if (listing.contact.whatsapp) issues.push(issue("contact.whatsapp", "phone_required"));
  }
  return issues;
}

/** Index of `issues` by path, for the tests and the wizard summary. */
export function issuesByPath(issues: readonly FieldIssue[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of issues) map.set(item.path, [...(map.get(item.path) ?? []), item.code]);
  return map;
}
