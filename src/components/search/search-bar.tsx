"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import type { Locale } from "@/config/site";
import { canonicalSearchParams, SEARCH_PATH, SEARCH_Q_MAX, SEARCH_QUERY_KEYS, searchParamsToQuery, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { SearchCityCombobox } from "./city-combobox";
import { locationOf, sameLocation, type LocationValue } from "./location";
import { useSearchNavigation } from "./search-navigation";

// Words + place of the search page (design D21). A GET form that also works before hydration
// (the other filters ride along as hidden inputs); once hydrated, submitting navigates in a
// transition and keeps every other filter. A new place drops the radius and district of the old one.

/** URL keys the bar itself sets: everything else is carried over unchanged. */
const OWN_KEYS: readonly string[] = [SEARCH_QUERY_KEYS.q, SEARCH_QUERY_KEYS.raw, SEARCH_QUERY_KEYS.city, SEARCH_QUERY_KEYS.region, SEARCH_QUERY_KEYS.radius, SEARCH_QUERY_KEYS.district, SEARCH_QUERY_KEYS.page];

/** The search after the bar was submitted with these words and this place (typed words are interpreted again: no `raw`). */
export function submittedParams(current: SearchParams, q: string, location: LocationValue): SearchParams {
  const next: SearchParams = { ...current, q: q.replace(/\s+/g, " ").trim() || undefined, raw: undefined, page: undefined };
  if (!sameLocation(locationOf(current), location)) {
    next.city = location.city;
    next.region = location.city ? undefined : location.region;
    delete next.radiusKm;
    delete next.district;
    delete next.zone;
  }
  if (!next.q && next.sort === "relevance") delete next.sort;
  return canonicalSearchParams(next);
}

/** Hidden inputs that keep the other filters in a no-JS submission. */
export function carriedInputs(params: SearchParams): [string, string][] {
  return [...searchParamsToQuery(params)].filter(([key]) => !OWN_KEYS.includes(key));
}

export function SearchBar({ params, className }: { params: SearchParams; className?: string }) {
  const t = useTranslations("Search.bar");
  const location = useTranslations("Search.location");
  const locale = useLocale() as Locale;
  const navigation = useSearchNavigation();
  const [q, setQ] = useState(params.q ?? "");
  const [place, setPlace] = useState<LocationValue>(locationOf(params));

  return (
    <form
      action={`/${locale}${SEARCH_PATH}`}
      method="get"
      role="search"
      aria-label={t("label")}
      onSubmit={(event) => {
        if (!navigation) return;
        event.preventDefault();
        navigation.navigate(submittedParams(params, q, place));
      }}
      className={cn("grid gap-2 rounded-lg bg-surface p-2 shadow-lg shadow-bab-950/10 ring-1 ring-border sm:grid-cols-[1.5fr_1fr_auto]", className)}
    >
      <div className="relative">
        <label htmlFor="search-q" className="sr-only">
          {t("queryLabel")}
        </label>
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
        <input
          id="search-q"
          name={SEARCH_QUERY_KEYS.q}
          type="search"
          enterKeyHint="search"
          maxLength={SEARCH_Q_MAX}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={t("queryPlaceholder")}
          className={cn(inputClassName, "h-12 border-transparent bg-surface-muted ps-9")}
        />
      </div>
      <SearchCityCombobox
        value={place}
        onChange={setPlace}
        label={location("label")}
        hideLabel
        names={{ city: SEARCH_QUERY_KEYS.city, region: SEARCH_QUERY_KEYS.region }}
        inputClassName="h-12 border-transparent bg-surface-muted"
      />
      {carriedInputs(params).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <Button type="submit" size="lg" className="h-12" loading={navigation?.pending}>
        {navigation?.pending ? null : <Search aria-hidden="true" />}
        {t("submit")}
      </Button>
    </form>
  );
}
