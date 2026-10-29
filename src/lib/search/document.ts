import "server-only";
import { criterionById, subcategoryById } from "@/config/categories";
import { cityBySlug, regionByCode } from "@/config/regions";
import { availableValues, isSoldOut, isVariantCriterion, priceRange, promoSummary } from "@/lib/contracts/catalog";
import type { ListingStatus, ModerationState } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { ListingDoc } from "@/lib/db/schemas";
import ar from "../../../messages/ar.json";
import fr from "../../../messages/fr.json";
import { blockedDays, freshUntil, moroccoToday } from "@/lib/listings/rental-availability";
import { foldDigits } from "./normalize";
import { districtKey } from "./params";
import { SEARCH_DESCRIPTION_MAX, SITEMAP_SHARDS, attributeField, sitemapShardOf, type SearchDocument } from "./types";

// Listing -> search document (design D4, D9; architecture §5 "Ce qui vit dans Meilisearch").
// Public data only: never the owner uid, proId, phone, contact settings or an exact position.
// Labels (category, criteria options, condition) come from the fr and ar messages so a search in
// either script finds the listing; Tarifit in Latin script follows French (§5). Cities and regions
// carry their own fr/ar names (src/config/regions.ts).

type Tree = { readonly [key: string]: string | Tree };
const LABELS: readonly Tree[] = [fr as unknown as Tree, ar as unknown as Tree];

/** Moderation outcomes that may be shown publicly (D9). */
const PUBLIC_MODERATION: ReadonlySet<ModerationState> = new Set<ModerationState>(["auto_ok", "human_ok"]);

/** Option ids that carry no search meaning ("Autre"). */
const SILENT_OPTIONS: ReadonlySet<string> = new Set(["autre"]);

/** `_geo` precision: 2 decimals (~1 km), like the stored centroid; never finer. */
const GEO_DECIMALS = 100;

/** What `isIndexable` reads: a full listing, or the projection the reconciliation selects. */
export interface IndexableFields {
  status: ListingStatus;
  slugId?: string;
  categoryId?: string;
  subcategoryId?: string;
  location?: { regionCode: string; citySlug: string };
  moderation: { state: ModerationState; hiddenBy?: unknown };
}

/**
 * D9: published, not hidden by a report, moderation auto_ok or human_ok, and the fields a search
 * document needs (slugId, category, subcategory, location). Anything else is removed from the index.
 */
export function isIndexable(listing: IndexableFields): boolean {
  return (
    listing.status === "published" &&
    !listing.moderation.hiddenBy &&
    PUBLIC_MODERATION.has(listing.moderation.state) &&
    Boolean(listing.slugId && listing.categoryId && listing.subcategoryId && listing.location)
  );
}

function lookup(tree: Tree, path: readonly string[]): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const key of path) {
    if (typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return typeof node === "string" && node.trim() ? node.trim() : undefined;
}

/** French and Arabic labels at `path` (Arabic missing: French only). */
function labels(path: readonly string[]): string[] {
  return LABELS.map((tree) => lookup(tree, path)).filter((value): value is string => value !== undefined);
}

/** Distinct non-empty parts, in order, joined by spaces. */
function joinText(parts: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  for (const part of parts) {
    const value = part?.replace(/\s+/g, " ").trim();
    if (value) seen.add(value);
  }
  return [...seen].join(" ");
}

/** Cuts `text` to `max` characters on a word boundary when one is close, never inside a surrogate pair. */
export function truncateText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  return (space > max - 80 ? cut.slice(0, space) : cut).trimEnd();
}

function roundGeo(value: number): number {
  return Math.round(value * GEO_DECIMALS) / GEO_DECIMALS;
}

type AttributeValue = ListingRecord["attributes"][string];
type DocumentAttribute = string | string[] | number | boolean;

/** Text of one criterion: option labels (fr, ar), free text as typed, the criterion label of a true flag. */
function criterionText(id: string, value: AttributeValue): string[] {
  const criterion = criterionById(id);
  if (!criterion) return [];
  switch (criterion.type) {
    case "select":
      return typeof value === "string" && !SILENT_OPTIONS.has(value) ? labels(["Criteria", id, "options", value]) : [];
    case "multiselect":
      return Array.isArray(value) ? value.filter((option) => !SILENT_OPTIONS.has(option)).flatMap((option) => labels(["Criteria", id, "options", option])) : [];
    case "text":
      return typeof value === "string" ? [value] : [];
    case "boolean":
      return value === true ? labels(["Criteria", id, "label"]) : [];
    case "number":
      return [];
  }
}

/** Filterable value of one criterion (`a_*` field), or undefined when the type does not match. */
function criterionValue(id: string, value: AttributeValue): DocumentAttribute | undefined {
  const criterion = criterionById(id);
  if (!criterion) return undefined;
  const options: readonly string[] = criterion.options ?? [];
  switch (criterion.type) {
    case "select":
      return typeof value === "string" && options.includes(value) ? value : undefined;
    case "multiselect": {
      const values = Array.isArray(value) ? value.filter((option) => options.includes(option)) : [];
      return values.length > 0 ? values : undefined;
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "text":
      return undefined;
  }
}

/**
 * The search document of a listing, or null when it must not be in the index (`isIndexable`).
 * `now` drops an À la Une end date already past, so an expiry re-index clears it (D8).
 */
/** A current or scheduled promotion (catalogue §4): the engine filters on its dates at query time. */
function promoFields(listing: Pick<ListingDoc, "promo">): Partial<SearchDocument> {
  const promo = listing.promo;
  const summary = promo ? promoSummary(promo) : null;
  if (!promo || !summary) return {};
  return { promoStartsAt: promo.startsAt.getTime(), promoEndsAt: promo.endsAt.getTime(), promoKind: promo.kind, promoPercent: summary.percent, promoPrice: summary.price, promoReference: summary.reference ?? 0 };
}

export function toSearchDocument(listing: ListingRecord, now: Date = new Date()): SearchDocument | null {
  if (!isIndexable(listing)) return null;
  const { slugId, categoryId, subcategoryId, location } = listing;
  if (!slugId || !categoryId || !subcategoryId || !location) return null;

  const city = cityBySlug(location.citySlug);
  const region = regionByCode(location.regionCode);
  const district = location.district ? districtKey(location.district) : "";
  const criteria = subcategoryById(subcategoryId)?.criteria ?? [];

  const attrsText: string[] = [];
  const attributes: Record<`a_${string}`, DocumentAttribute> = {};
  const shown: Record<string, AttributeValue> = {};
  for (const criterion of criteria) {
    if (!Object.hasOwn(listing.attributes, criterion.id)) continue;
    const value = listing.attributes[criterion.id];
    if (value === undefined) continue;
    shown[criterion.id] = value;
    attrsText.push(...criterionText(criterion.id, value));
    const filterable = criterionValue(criterion.id, value);
    if (filterable !== undefined) attributes[attributeField(criterion.id)] = filterable;
  }
  if (listing.condition) attrsText.push(...labels(["Criteria", "condition", "options", listing.condition]));
  // Variants (Pro catalogue §2): a criterion axis filters on the values still sold (« taille 42
  // disponible »), a free axis is searchable text (« 500 g »).
  for (const axis of listing.variants?.axes ?? []) {
    if (isVariantCriterion(axis.id)) {
      if (!criteria.some((criterion) => criterion.id === axis.id)) continue;
      const sold = availableValues(listing.variants!, axis.id);
      const values = sold.length > 0 ? sold : axis.values;
      attrsText.push(...values.filter((value) => !SILENT_OPTIONS.has(value)).flatMap((value) => labels(["Criteria", axis.id, "options", value])));
      attributes[attributeField(axis.id)] = values;
    } else {
      attrsText.push(axis.label ?? "", ...axis.values);
    }
  }
  // Queries fold Arabic-Indic digits (normalizeQuery): index a folded copy of a title that has any,
  // and keep the displayed title as written. Free text (criteria, district) is folded below.
  const title = listing.title.trim();
  const foldedTitle = foldDigits(title);
  if (foldedTitle !== title) attrsText.push(foldedTitle);

  const photo = listing.photos[0];
  const featuredUntil = listing.boosts.featuredUntil?.getTime();
  const range = priceRange(listing);
  const price = range?.min;
  // Car rentals (rental pack §4): blocked days from today on, and the end of the fresh window.
  const rentalDays = listing.rental ? blockedDays(listing.rental.unavailable, moroccoToday(now)) : [];

  return {
    id: listing.id,
    slugId,
    title,
    description: foldDigits(truncateText(listing.description, SEARCH_DESCRIPTION_MAX)),
    categoryText: joinText([...labels(["Categories", categoryId, "name"]), ...labels(["Categories", categoryId, "sub", subcategoryId])]),
    placeText: foldDigits(joinText([city?.nameFr, city?.nameAr, region?.nameFr, region?.nameAr, location.district])),
    attrsText: foldDigits(joinText(attrsText)),
    categoryId,
    subcategoryId,
    regionCode: location.regionCode,
    citySlug: location.citySlug,
    ...(district ? { district } : {}),
    sellerType: listing.sellerType,
    sellerPublicId: listing.sellerPublicId,
    ...(listing.sectionId ? { sectionId: listing.sectionId } : {}),
    ...(price !== undefined ? { price } : {}),
    priceNegotiable: listing.priceNegotiable,
    isDonation: listing.isDonation,
    ...(listing.condition ? { condition: listing.condition } : {}),
    attributes: shown,
    hasPhoto: photo !== undefined,
    ...(photo ? { photo: { id: photo.id, w: photo.w, h: photo.h, blurhash: photo.blurhash } } : {}),
    photoCount: listing.photos.length,
    sortAt: listing.sortAt.getTime(),
    updatedAt: listing.updatedAt.getTime(),
    // Example listings stay out of every sitemap file (listingShards keeps 0 to SITEMAP_SHARDS - 1).
    sitemapShard: listing.example ? SITEMAP_SHARDS : sitemapShardOf(listing.id),
    isBumped: listing.sortSource === "bump",
    ...(featuredUntil !== undefined && featuredUntil > now.getTime() ? { featuredUntil } : {}),
    ...(listing.example ? { isExample: true as const } : {}),
    ...(rentalDays.length ? { rentUnavailableDays: rentalDays } : {}),
    ...(listing.rental ? { rentFreshUntil: freshUntil(listing.rental.updatedAt) } : {}),
    ...(isSoldOut(listing) ? { soldOut: true as const } : {}),
    ...(range && range.max > range.min ? { priceFrom: true as const } : {}),
    ...promoFields(listing),
    _geo: { lat: roundGeo(location.geo.lat), lng: roundGeo(location.geo.lng) },
    version: listing.version,
    ...attributes,
  };
}
