import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import type { SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { useFilterLabels } from "./filter-labels";
import { clearFilters, describeFilters } from "./filter-model";
import { SearchLink } from "./search-navigation";

// The active filters as removable chips (design §2 L3b): each chip is a link to the same search
// without it, so removal works before hydration and opens in a new tab like any link.

export const chipClassName = cn(
  "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-structure/30 bg-surface-brand ps-3.5 pe-2.5 text-sm font-medium text-foreground sm:min-h-9",
  "transition-[background-color,border-color] duration-150 ease-door hover:border-structure/60 hover:bg-cream-300/60 dark:hover:bg-bab-700",
  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
);

export function ActiveFilterChips({ params, locale, className }: { params: SearchParams; locale: Locale; className?: string }) {
  const t = useTranslations("SearchFilters");
  const labels = useFilterLabels();
  const filters = describeFilters(params, locale, labels);
  if (filters.length === 0) return null;
  return (
    <ul aria-label={t("active")} className={cn("flex flex-wrap items-center gap-2", className)}>
      {filters.map((filter) => (
        <li key={filter.key} className="min-w-0 max-w-full">
          <SearchLink params={filter.without} scroll={false} aria-label={t("remove", { filter: filter.label })} data-filter={filter.key} className={chipClassName}>
            <span className="truncate">{filter.label}</span>
            <X className="size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
          </SearchLink>
        </li>
      ))}
      {filters.length > 1 ? (
        <li>
          <SearchLink params={clearFilters(params)} scroll={false} className="inline-flex min-h-11 items-center rounded-sm px-2 text-sm font-medium text-link underline underline-offset-4 hover:no-underline sm:min-h-9">
            {t("clearAll")}
          </SearchLink>
        </li>
      ) : null}
    </ul>
  );
}
