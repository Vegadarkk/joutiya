"use client";

import { useDeferredValue, useId, useState } from "react";
import { Search, ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { quietLinkClassName } from "@/components/ui/text-link";
import type { GuideProcedureId, GuideRubric } from "@/content/guide/catalog";
import { Link } from "@/i18n/navigation";
import { normalizeText } from "@/lib/text/normalize";
import { cn } from "@/lib/utils";

// Search field of the procedures guide home (journey review 2026-10-29: the visitor had to guess the
// rubric). The page lists its procedures once, built ahead with the page; the field narrows them
// to the words typed (normalized like the search), each hit leading to the procedure on its rubric.

export interface GuideSearchEntry {
  id: GuideProcedureId;
  title: string;
  rubric: GuideRubric;
  rubricTitle: string;
}

/** The entries whose title or rubric holds every word typed; none while nothing is typed. */
export function matchGuideEntries(entries: readonly GuideSearchEntry[], query: string): GuideSearchEntry[] | null {
  const words = normalizeText(query).split(" ").filter((word) => word.length > 1);
  if (words.length === 0) return null;
  return entries.filter((entry) => {
    const haystack = normalizeText(`${entry.title} ${entry.rubricTitle}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function GuideSearch({ entries, className }: { entries: readonly GuideSearchEntry[]; className?: string }) {
  const t = useTranslations("Guide.search");
  const id = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const hits = matchGuideEntries(entries, deferred);
  return (
    <section aria-labelledby={`${id}-label`} className={cn("flex flex-col gap-3", className)}>
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
        {t("label")}
      </label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-foreground-muted" />
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("placeholder")}
          autoComplete="off"
          enterKeyHint="search"
          aria-describedby={`${id}-hint`}
          aria-controls={`${id}-results`}
          className="h-12 ps-10 text-base"
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-foreground-muted text-pretty">
        {t("hint")}
      </p>
      <div id={`${id}-results`} role="region" aria-live="polite" aria-atomic="false">
        {hits === null ? null : hits.length === 0 ? (
          <p className="rounded-md border border-border bg-surface-muted/60 px-4 py-3 text-sm text-foreground-muted text-pretty">{t("none")}</p>
        ) : (
          <>
            <p className="mb-1.5 text-sm text-foreground-muted">{t("results", { count: hits.length })}</p>
            <ul className="divide-y divide-border rounded-md border border-border bg-surface">
              {hits.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={`/demarches/${entry.rubric}#procedure-${entry.id}`}
                    prefetch={false}
                    className={cn("flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm font-medium text-link", quietLinkClassName)}
                  >
                    <ScrollText aria-hidden="true" className="size-4 shrink-0 text-structure dark:text-gold-300" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>{entry.title}</span>
                      <span className="text-xs font-normal text-foreground-muted">{entry.rubricTitle}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
