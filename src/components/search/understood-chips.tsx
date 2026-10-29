import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { textLinkClassName } from "@/components/ui/text-link";
import type { Locale } from "@/config/site";
import type { AppliedSearch } from "@/lib/search/interpret";
import { cn } from "@/lib/utils";
import { useFilterLabels } from "./filter-labels";
import { describeFilters } from "./filter-model";
import { NearMeButton } from "./near-me-button";
import { SearchLink } from "./search-navigation";

// « Chercher en parlant » (Carte vivante, lot 4): what the search understood in the typed sentence,
// above the results. Each chip is the filter it became, in the words of the filter chips; its ×
// links to the search without it, the words then searched as typed (`brut=1`). « Compris » marks
// the row; « Chercher le texte exact » searches the whole sentence as words. A « près de moi »
// waits for « Utiliser ma position ».

/** Dark green: what Joutiya read, apart from the filters set by hand. */
const understoodChip = cn(
  "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full bg-structure ps-3.5 pe-2.5 text-sm font-medium text-structure-foreground sm:min-h-9 dark:bg-bab-600",
  "transition-[background-color,scale] duration-150 ease-door hover:bg-bab-800 active:scale-[0.98] dark:hover:bg-bab-500",
);

/** The filter chips the understood row already shows (their keys, for ActiveFilterChips' `hide`). */
export function understoodChipKeys(interpreted: AppliedSearch | null): string[] | undefined {
  if (!interpreted) return undefined;
  const keys: string[] = interpreted.items.map((item) => item.key);
  // « À 3 km de vous » is the zone: no second « Zone de la carte » chip beside it.
  if (interpreted.near?.state === "zone") keys.push("location");
  return keys;
}

export function UnderstoodChips({ interpreted, locale, className }: { interpreted: AppliedSearch; locale: Locale; className?: string }) {
  const t = useTranslations("SearchInterpret");
  const labels = useFilterLabels();
  const filterLabels = new Map<string, string>(describeFilters(interpreted.params, locale, labels).map((filter) => [filter.key, filter.label]));
  const near = interpreted.near;
  const chips = interpreted.items.flatMap((item) => {
    if (item.key === "near") return near?.state === "zone" ? [{ ...item, label: t("nearZone", { km: near.km }) }] : [];
    const label = item.key === "sort" ? t("sortCheap") : filterLabels.get(item.key);
    return label ? [{ ...item, label }] : [];
  });

  return (
    <section aria-labelledby="understood-title" data-testid="understood" className={cn("flex flex-wrap items-center gap-2", className)}>
      <h2 id="understood-title" className="sr-only">
        {t("label")}
      </h2>
      <span aria-hidden="true" className="inline-flex h-7 items-center gap-1 rounded-full bg-featured px-2.5 text-xs font-semibold text-featured-foreground">
        <Check className="size-3.5" strokeWidth={2.5} />
        {t("understood")}
      </span>
      {chips.length > 0 ? (
        <ul aria-labelledby="understood-title" className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <li key={chip.key} className="min-w-0 max-w-full">
              <SearchLink
                params={chip.without}
                scroll={false}
                aria-label={t("remove", { filter: chip.label })}
                title={t("from", { words: chip.words })}
                data-understood={chip.key}
                className={understoodChip}
              >
                <span className="truncate">{chip.label}</span>
                <X className="size-4 shrink-0 opacity-75" aria-hidden="true" />
              </SearchLink>
            </li>
          ))}
        </ul>
      ) : null}
      {near?.state === "ask" ? <NearMeButton target={near.target} km={near.km} /> : null}
      <SearchLink
        params={interpreted.exact}
        scroll={false}
        data-testid="search-exact"
        className={cn("inline-flex min-h-11 items-center rounded-sm px-1 text-sm font-medium text-link sm:min-h-9", textLinkClassName)}
      >
        {t("exact")}
      </SearchLink>
    </section>
  );
}
