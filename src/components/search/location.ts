import { cityBySlug, cityName, regionByCode, regionName, REGIONS, searchCities } from "@/config/regions";
import type { Locale } from "@/config/site";
import type { SearchParams } from "@/lib/search/params";
import { normalizeText } from "@/lib/text/normalize";

// Location choices of the search (design D7): the whole country, a region or a city, as the
// `region` / `ville` URL parameters. Pure and client-safe: the location combobox of the search bar,
// the home panel and the filters sheet build their options here.

export interface LocationValue {
  city?: string;
  region?: string;
}

export type LocationOption = { kind: "all" } | { kind: "region"; code: string } | { kind: "city"; slug: string };

/** Regions shown above the cities when the typed text names one. */
const MAX_REGIONS = 3;

export function locationOf(params: Pick<SearchParams, "city" | "region">): LocationValue {
  if (params.city && cityBySlug(params.city)) return { city: params.city };
  if (params.region && regionByCode(params.region)) return { region: params.region };
  return {};
}

export function sameLocation(a: LocationValue, b: LocationValue): boolean {
  if (a.city || b.city) return a.city === b.city;
  return (a.region ?? "") === (b.region ?? "");
}

export function optionValue(option: LocationOption): LocationValue {
  if (option.kind === "city") return { city: option.slug };
  if (option.kind === "region") return { region: option.code };
  return {};
}

/** Stable DOM key of an option (ids of the listbox). */
export function optionKey(option: LocationOption): string {
  if (option.kind === "city") return `c-${option.slug}`;
  if (option.kind === "region") return `r-${option.code}`;
  return "all";
}

export function isSelected(option: LocationOption, value: LocationValue): boolean {
  if (option.kind === "city") return value.city === option.slug;
  if (option.kind === "region") return !value.city && value.region === option.code;
  return !value.city && !value.region;
}

/** Name of the chosen place, or null for the whole country. */
export function locationName(value: LocationValue, locale: Locale): string | null {
  const city = value.city ? cityBySlug(value.city) : undefined;
  if (city) return cityName(city, locale);
  const region = value.region ? regionByCode(value.region) : undefined;
  return region ? regionName(region, locale) : null;
}

/**
 * Options for the typed text: empty -> the whole country then the major cities; otherwise the
 * matching regions (at most 3) then the matching cities, accent- and script-insensitive.
 */
export function locationOptions(query: string, locale: Locale, limit = 10): LocationOption[] {
  const q = normalizeText(query);
  if (!q) return [{ kind: "all" }, ...searchCities("", locale, limit).map((city) => ({ kind: "city" as const, slug: city.slug }))];
  const regions = REGIONS.filter((region) => {
    const names = [normalizeText(region.nameFr), normalizeText(region.nameAr)];
    return names.some((name) => name.startsWith(q) || name.split(" ").some((word) => word.startsWith(q)));
  })
    .slice(0, MAX_REGIONS)
    .map((region) => ({ kind: "region" as const, code: region.code }));
  const cities = searchCities(query, locale, limit).map((city) => ({ kind: "city" as const, slug: city.slug }));
  return [...regions, ...cities];
}

/** Secondary line of a city option: its region. */
export function regionOfCity(slug: string, locale: Locale): string | null {
  const city = cityBySlug(slug);
  const region = city ? regionByCode(city.regionCode) : undefined;
  return region ? regionName(region, locale) : null;
}
