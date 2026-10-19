import { useTranslations } from "next-intl";
import { ListingCardSkeleton } from "@/components/feedback/skeletons";
import { Container } from "@/components/layout/container";
import { Skeleton } from "@/components/ui/skeleton";
import { RESULTS_GRID_CLASS } from "./grid";

// Footprint of the search page while it loads: search band, heading, toolbar, 12 cards.

export function SearchResultsSkeleton({ count = 12 }: { count?: number }) {
  const t = useTranslations("SearchPage");
  return (
    <div role="status" aria-busy="true" data-testid="search-skeleton">
      <span className="sr-only">{t("loading")}</span>
      <div className="border-b border-border bg-surface-brand/60">
        <Container className="py-4 sm:py-6">
          <Skeleton className="h-[7.5rem] rounded-lg sm:h-16" />
        </Container>
      </div>
      <Container className="flex flex-col gap-5 pt-6 pb-12 sm:pt-8">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-2/3 max-w-sm" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-2 border-b border-border py-2">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="ms-auto h-11 w-40" />
        </div>
        <div className={RESULTS_GRID_CLASS}>
          {Array.from({ length: count }, (_, index) => (
            <ListingCardSkeleton key={index} />
          ))}
        </div>
      </Container>
    </div>
  );
}
