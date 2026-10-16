"use client";

import { useId } from "react";
import { ArrowDownUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/post/controls/select";
import { effectiveSort, SEARCH_SORTS, type SearchParams, type SearchSort } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { sortOptions, withSort } from "./filter-model";
import { useSearchNavigation } from "./search-navigation";

// Sort of the results (design D6): a native select (the OS picker on phones). Relevance only with
// words, distance only with a city; a change goes back to page 1.

export function SortSelect({ params, className }: { params: SearchParams; className?: string }) {
  const t = useTranslations("SearchFilters.sort");
  const navigation = useSearchNavigation();
  const id = useId();
  const current = effectiveSort(params);
  const options = sortOptions(params);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <label htmlFor={id} className="flex shrink-0 items-center gap-1.5 text-sm text-foreground-muted">
        <ArrowDownUp className="size-4" aria-hidden="true" />
        <span className="max-sm:sr-only">{t("label")}</span>
      </label>
      <Select
        id={id}
        value={current}
        disabled={!navigation}
        onChange={(event) => {
          const sort = SEARCH_SORTS.find((value) => value === event.target.value);
          if (sort && navigation) navigation.navigate(withSort(params, sort), { scroll: false });
        }}
        className="h-11 w-auto min-w-0 border-border bg-surface py-0 text-sm font-medium"
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
