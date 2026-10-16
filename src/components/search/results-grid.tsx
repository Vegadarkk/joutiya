import type { ReactNode } from "react";
import { ListingCard } from "@/components/listing/listing-card";
import type { Locale } from "@/config/site";
import type { SearchCard } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { cn } from "@/lib/utils";
import { cardBadge } from "./filter-model";
import { RESULTS_GRID_CLASS } from "./grid";

// Grid of engine cards (search page, home, /c pages of L4): 2 columns on phones, 3 from sm, 4 from
// lg, the ListingGridSkeleton footprint. Server component (reads the media host). `renderAction`
// puts a client island on each card (L5's FavoriteButton, wired by the page).

export interface ResultsGridProps {
  cards: SearchCard[];
  locale: Locale;
  renderAction?: (card: SearchCard) => ReactNode;
  /** Cards whose photo loads eagerly with high priority (first row: LCP). */
  priorityCount?: number;
  headingLevel?: "h2" | "h3";
  className?: string;
}

export function ResultsGrid({ cards, locale, renderAction, priorityCount = 0, headingLevel, className }: ResultsGridProps) {
  const media = mediaBaseUrl();
  return (
    <ul data-testid="results-grid" className={cn(RESULTS_GRID_CLASS, className)}>
      {cards.map((card, index) => (
        <li key={card.id} className="min-w-0">
          <ListingCard listing={card} mediaBaseUrl={media} locale={locale} headingLevel={headingLevel} badge={cardBadge(card)} action={renderAction?.(card)} priority={index < priorityCount} />
        </li>
      ))}
    </ul>
  );
}
