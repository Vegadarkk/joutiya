import { useTranslations } from "next-intl";
import { groupDigits } from "@/lib/listings/client/format";
import type { SearchParams } from "@/lib/search/params";
import type { SearchFacets } from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { useFilterLabels } from "./filter-labels";
import { refinements } from "./filter-model";
import { SearchLink } from "./search-navigation";

// Next refinement from the facet counts (Leboncoin's category shortcuts): the categories with
// listings while none is chosen, then the subcategories of the chosen one. One scrolling row on
// phones, wrapped from sm.

export function RefineChips({ params, facets, className }: { params: SearchParams; facets: SearchFacets | undefined; className?: string }) {
  const t = useTranslations("SearchPage.refine");
  const names = useFilterLabels();
  const items = refinements(params, facets);
  if (items.length < 2) return null;
  const subcategories = items[0]?.kind === "subcategory";
  return (
    <nav aria-label={subcategories ? t("subcategories") : t("categories")} className={cn("-mx-4 sm:mx-0", className)}>
      <ul className="flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <li key={item.id} className="shrink-0 snap-start">
            <SearchLink
              params={item.params}
              scroll={false}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm whitespace-nowrap sm:min-h-9",
                "transition-[border-color,background-color,scale] duration-150 ease-door hover:border-structure/50 hover:bg-surface-muted active:scale-[0.98]",
                // The phone row scrolls and clips outside its chips: the focus ring goes inside.
                "max-sm:focus-visible:-outline-offset-2",
              )}
            >
              <span className="font-medium">{item.kind === "subcategory" ? names.subcategory(item.categoryId, item.id) : names.category(item.id)}</span>
              <span className="text-foreground-muted tabular-nums">{groupDigits(String(item.count))}</span>
            </SearchLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
