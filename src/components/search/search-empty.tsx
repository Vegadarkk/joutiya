import type { ReactNode } from "react";
import { CirclePlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";
import { Button } from "@/components/ui/button";
import { regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { isBlankSearch, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { chipClassName } from "./active-filter-chips";
import { useFilterLabels } from "./filter-labels";
import { clearFilters, describeFilters, widenings, withPage } from "./filter-model";
import { SearchLink } from "./search-navigation";

// No result (design §2 L3b): say so plainly, then offer the next step: remove one filter, widen
// the place, check the words, or start over. A search with no filter at all means the site has no
// listing yet: invite to post one. `action` takes L5's "save this search" (alerts). No `w-full` on the
// section: the map panel gives it side margins (globals.css) and a full width overflowed it (UX audit, 2).

interface SearchEmptyProps {
  params: SearchParams;
  locale: Locale;
  /** Hits exist but this page is past the last one (stale link). */
  outOfRange?: boolean;
  action?: ReactNode;
  className?: string;
}

export function SearchEmpty({ params, locale, outOfRange = false, action, className }: SearchEmptyProps) {
  const t = useTranslations("SearchPage.empty");
  const chips = useTranslations("SearchFilters");
  const labels = useFilterLabels();

  if (outOfRange) {
    return (
      <section data-testid="search-empty" className={cn("mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center", className)}>
        <DoorMark className="w-16" />
        <h2 className="text-xl font-semibold text-balance">{t("outOfRangeTitle")}</h2>
        <Button asChild variant="outline">
          <SearchLink params={withPage(params, 1)}>{t("firstPage")}</SearchLink>
        </Button>
      </section>
    );
  }

  if (isBlankSearch(params)) {
    return (
      <section data-testid="search-empty" className={cn("mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center", className)}>
        <DoorMark className="w-16" />
        <h2 className="text-xl font-semibold text-balance">{t("blankTitle")}</h2>
        <p className="text-foreground-muted text-pretty">{t("blankBody")}</p>
        <Button asChild>
          <Link href="/deposer">
            <CirclePlus aria-hidden="true" />
            {t("post")}
          </Link>
        </Button>
      </section>
    );
  }

  const filters = describeFilters(params, locale, labels);
  const wider = widenings(params);
  return (
    <section data-testid="search-empty" aria-labelledby="search-empty-title" className={cn("mx-auto flex max-w-xl flex-col items-center gap-5 py-12 text-center", className)}>
      <DoorMark className="w-16" />
      <div className="flex flex-col gap-2">
        <h2 id="search-empty-title" className="text-xl font-semibold text-balance">
          {t("title")}
        </h2>
        <p className="text-foreground-muted text-pretty">{params.q ? t("bodyWords") : t("body")}</p>
      </div>
      {filters.length > 0 ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium">{t("removeFilter")}</p>
          <ul className="flex flex-wrap justify-center gap-2">
            {filters.map((filter) => (
              <li key={filter.key} className="min-w-0 max-w-full">
                <SearchLink params={filter.without} aria-label={chips("remove", { filter: filter.label })} className={chipClassName}>
                  <span className="truncate">{filter.label}</span>
                  <X className="size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
                </SearchLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-center gap-3">
        {wider.map((option) => {
          const region = option.kind === "region" ? regionByCode(option.code) : undefined;
          return (
            // Long region names ("Rabat-Salé-Kénitra") wrap instead of widening a phone page.
            <Button key={option.kind} asChild variant="outline" className="h-auto min-h-11 max-w-full py-2 text-center whitespace-normal">
              <SearchLink params={option.params}>{region ? t("widenRegion", { region: regionName(region, locale) }) : t("widenCountry")}</SearchLink>
            </Button>
          );
        })}
        {filters.length > 1 ? (
          <Button asChild variant="ghost">
            <SearchLink params={clearFilters(params)}>{t("clearAll")}</SearchLink>
          </Button>
        ) : null}
      </div>
      {action ? <div className="flex justify-center">{action}</div> : null}
    </section>
  );
}
