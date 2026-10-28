"use client";

import { useDeferredValue, useId, useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { inputClassName } from "@/components/ui/input";
import { quietLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { matchHelp, queryTokens, type HelpEntry } from "@/lib/help/match";
import { cn } from "@/lib/utils";

// Search box of /aide (design phase-5 D25): filters the locale's articles in the browser (titles,
// summaries, search terms: a few kilobytes, no request). While a query is typed, the results
// replace the theme listing passed as children.

export interface HelpSearchEntry extends HelpEntry {
  category: string;
}

export function HelpSearch({ entries, children }: { entries: readonly HelpSearchEntry[]; children: ReactNode }) {
  // Plurals print numbers: French formatting on Tarifit pages (no Tarifit text here).
  const t = useNumbersTranslations("Help.search");
  const inputId = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const active = queryTokens(deferred).length > 0;
  const results = useMemo(() => (active ? matchHelp(entries, deferred, 8) : []), [active, entries, deferred]);

  return (
    <div className="flex flex-col gap-8">
      <div role="search" className="relative">
        <label htmlFor={inputId} className="sr-only">
          {t("label")}
        </label>
        <Search className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={100}
          enterKeyHint="search"
          autoComplete="off"
          placeholder={t("placeholder")}
          className={cn(inputClassName, "h-13 rounded-lg ps-12 pe-12 text-base shadow-sm [&::-webkit-search-cancel-button]:hidden")}
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("clear")}
            className="absolute end-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-foreground-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p aria-live="polite" className={active ? "text-sm text-foreground-muted" : "sr-only"}>
        {active ? (results.length > 0 ? t("results", { count: results.length }) : t("noResults", { query: deferred.trim() })) : ""}
      </p>

      {active ? (
        results.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {results.map((entry) => (
              <li key={entry.slug}>
                <Link href={`/aide/${entry.slug}`} className={cn("group flex flex-col gap-1 py-4", quietLinkClassName)}>
                  <span className="text-xs font-medium text-structure dark:text-gold-300">{entry.category}</span>
                  <span className="font-semibold group-hover:underline">{entry.title}</span>
                  <span className="text-sm text-pretty text-foreground-muted">{entry.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        children
      )}
    </div>
  );
}
