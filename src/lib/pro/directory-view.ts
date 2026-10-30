import { cityBySlug } from "@/config/regions";
import { PRO_SECTORS, type ProSector } from "@/lib/pro/profile-schema";
import { DIRECTORY_PATH } from "@/lib/search/shortcuts";

// The directory of verified shops and agencies (/boutiques; owner's choice of 30 Oct 2026, UX
// journeys counter-review): the filters as path segments so the page stays ISR, the sorting and
// the facet counts. Pure and client-safe: the page, the sitemap and the unit tests share it; the
// Firestore side is ./directory.ts.

export interface DirectoryShop {
  proId: string;
  /** URL segment "{slug}-{proId}" of /boutique. */
  segment: string;
  name: string;
  /** First paragraph of the shop's description, shortened. */
  excerpt: string;
  citySlug: string;
  sector: ProSector;
  /** Example shop (src/lib/demo): labelled, listed last. */
  example: boolean;
  /** Badge « Certifié »: the pieces were checked in detail. */
  certified: boolean;
  /** The owner's active listings (users.stats, denormalised). */
  listings: number;
}

export interface DirectoryFilter {
  city?: string;
  sector?: ProSector;
}

/** URL segment of each activity: /boutiques/activite/{segment}. */
export const SECTOR_SEGMENTS: Record<ProSector, string> = {
  general: "boutiques",
  real_estate: "agences-immobilieres",
  car_rental: "location-voitures",
  holiday_rental: "location-saisonniere",
};

/** Cities offered as chips, by number of shops; the current city is added when it is beyond. */
export const DIRECTORY_CITY_CHIPS = 12;

/** Longest excerpt on a card. */
export const EXCERPT_MAX = 160;

export function sectorBySegment(segment: string): ProSector | null {
  return PRO_SECTORS.find((sector) => SECTOR_SEGMENTS[sector] === segment) ?? null;
}

/**
 * The filter named by the path after /boutiques: nothing, `ville/{city}`, `activite/{activity}`
 * or `ville/{city}/activite/{activity}` in that order (one address per page); anything else, an
 * unknown city or activity included, is a 404.
 */
export function parseDirectorySegments(rest: readonly string[]): DirectoryFilter | null {
  const filter: DirectoryFilter = {};
  let index = 0;
  if (rest[index] === "ville") {
    const city = rest[index + 1];
    if (!city || !cityBySlug(city)) return null;
    filter.city = city;
    index += 2;
  }
  if (rest[index] === "activite") {
    const segment = rest[index + 1];
    const sector = segment ? sectorBySegment(segment) : null;
    if (!sector) return null;
    filter.sector = sector;
    index += 2;
  }
  return index === rest.length ? filter : null;
}

/** Path without the locale of a filter, the inverse of `parseDirectorySegments`. */
export function directoryPath(filter: DirectoryFilter): string {
  const parts = [DIRECTORY_PATH];
  if (filter.city) parts.push("ville", filter.city);
  if (filter.sector) parts.push("activite", SECTOR_SEGMENTS[filter.sector]);
  return parts.join("/");
}

export function filterShops(shops: readonly DirectoryShop[], filter: DirectoryFilter): DirectoryShop[] {
  return shops.filter((shop) => (!filter.city || shop.citySlug === filter.city) && (!filter.sector || shop.sector === filter.sector));
}

/** Real shops before the examples, the ones with listings before the empty ones, then by name. */
export function sortShops(shops: readonly DirectoryShop[], locale = "fr"): DirectoryShop[] {
  const collator = new Intl.Collator(locale === "ar" ? "ar" : "fr", { sensitivity: "base" });
  return [...shops].sort((a, b) => Number(a.example) - Number(b.example) || Number(b.listings > 0) - Number(a.listings > 0) || collator.compare(a.name, b.name));
}

/** Cities of the shops, the fullest first, ties by slug. */
export function countByCity(shops: readonly DirectoryShop[]): { city: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const shop of shops) counts.set(shop.citySlug, (counts.get(shop.citySlug) ?? 0) + 1);
  return [...counts.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
}

export function countBySector(shops: readonly DirectoryShop[]): Record<ProSector, number> {
  const counts = Object.fromEntries(PRO_SECTORS.map((sector) => [sector, 0])) as Record<ProSector, number>;
  for (const shop of shops) counts[shop.sector] += 1;
  return counts;
}

/** The first paragraph of a description, cut on a word before `max` characters. */
export function excerptOf(description: string, max = EXCERPT_MAX): string {
  const first = description.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,;:.]+$/, "")}…`;
}
