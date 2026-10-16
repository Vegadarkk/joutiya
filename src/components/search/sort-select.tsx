"use client";

import { startTransition, useId, useOptimistic } from "react";
import { ArrowDownUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/post/controls/select";
import { effectiveSort, SEARCH_SORTS, type SearchParams, type SearchSort } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { sortOptions, withSort } from "./filter-model";
import { useSearchNavigation } from "./search-navigation";

// Sort of the results (design D6): a native select (the OS picker on phones). Relevance only with
// words, distance only with a city; a change goes back to page 1. The picked sort shows at once
// (optimistic, same transition as the navigation) instead of the old one until the results arrive.
// Phones show the select alone (its label stays for screen readers) and it shrinks with the
// toolbar: at 360 px with filters on, the select truncates rather than widen the page.

export function SortSelect({ params, className }: { params: SearchParams; className?: string }) {
  const t = useTranslations("SearchFilters.sort");
  const navigation = useSearchNavigation();
  const id = useId();
  const current = effectiveSort(params);
  const [shown, setShown] = useOptimistic<SearchSort>(current);
  const options = sortOptions(params);
  return (
    <div className={cn("flex min-w-0 items-center gap-2 *:min-w-0", className)}>
      <label htmlFor={id} className="flex shrink-0 items-center gap-1.5 text-sm text-foreground-muted max-sm:sr-only">
        <ArrowDownUp className="size-4" aria-hidden="true" />
        {t("label")}
      </label>
      <Select
        id={id}
        value={shown}
        disabled={!navigation}
        onChange={(event) => {
          const sort = SEARCH_SORTS.find((value) => value === event.target.value);
          if (!sort || !navigation) return;
          startTransition(() => {
            setShown(sort);
            navigation.navigate(withSort(params, sort), { scroll: false });
          });
        }}
        className="h-11 w-auto max-w-full min-w-0 truncate border-border bg-surface py-0 pe-9 text-sm font-medium"
      >
        {options.map((sort: SearchSort) => (
          <option key={sort} value={sort}>
            {t(sort)}
          </option>
        ))}
      </Select>
    </div>
  );
}
