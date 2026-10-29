import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { cityName, nearestCity } from "@/config/regions";
import type { Locale } from "@/config/site";
import { useFilterLabels } from "@/components/search/filter-labels";
import { describeFilters, type FilterLabels } from "@/components/search/filter-model";
import { SAVED_SEARCH_NAME_MAX } from "@/lib/contracts/search";
import type { SearchParams } from "@/lib/search/params";

// Words of a saved search (design D18): the typed words, then the active filters with the very
// labels of the search page chips (filter-model.ts), so a search reads the same everywhere. A map
// zone is named by its nearest city ("Zone de la carte · 12 km autour de Casablanca"), never by
// its coordinates: the name proposed for the alert and its e-mail say where it is.

/** Words of a map zone: its radius around the nearest city. */
export function zoneLabel(zone: NonNullable<SearchParams["zone"]>, locale: Locale, labels: FilterLabels): string {
  const city = nearestCity(zone.lat, zone.lng);
  return city ? labels.chip("zoneNear", { km: String(zone.km), place: cityName(city, locale) }) : labels.chip("zone", { km: String(zone.km) });
}

export function summarizeSearch(params: SearchParams, locale: Locale, labels: FilterLabels, quote: (q: string) => string): string[] {
  const filters = describeFilters(params, locale, labels).map((filter) => (filter.key === "location" && params.zone ? zoneLabel(params.zone, locale, labels) : filter.label));
  return [...(params.q ? [quote(params.q)] : []), ...filters];
}

/** Proposed name: the first parts of the summary that fit SAVED_SEARCH_NAME_MAX, or `fallback`. */
export function suggestSearchName(parts: readonly string[], separator: string, fallback: string): string {
  let name = "";
  for (const part of parts.slice(0, 3)) {
    const next = name ? `${name}${separator}${part}` : part;
    if (next.length > SAVED_SEARCH_NAME_MAX) break;
    name = next;
  }
  return name || parts[0]?.slice(0, SAVED_SEARCH_NAME_MAX).trim() || fallback;
}

export function useSearchSummary(): { summarize: (params: SearchParams) => string[]; suggest: (params: SearchParams) => string } {
  const t = useTranslations("SavedSearches.summary");
  const locale = useLocale() as Locale;
  const labels = useFilterLabels();
  const summarize = useCallback((params: SearchParams) => summarizeSearch(params, locale, labels, (q) => t("words", { q })), [labels, locale, t]);
  const suggest = useCallback(
    (params: SearchParams) =>
      suggestSearchName(
        summarizeSearch(params, locale, labels, (q) => q),
        labels.separator,
        t("fallbackName"),
      ),
    [labels, locale, t],
  );
  return { summarize, suggest };
}
