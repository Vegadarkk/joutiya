import type { Locale } from "@/config/site";
import { useNumbersTranslations } from "@/i18n/numbers";
import type { RatingSummary } from "@/lib/contracts/reviews";
import { cn } from "@/lib/utils";
import { formatAverage } from "./seller-reviews";
import { Stars } from "./stars";

// "★★★★½ 4,6 · 12 avis" next to a seller's name, down to the storefront's reviews block (`#avis`),
// on /profil itself or from the listing page's seller card. Nothing while there is no review.

export function RatingLink({ rating, locale, href = "#avis", className }: { rating: RatingSummary; locale: Locale; href?: string; className?: string }) {
  const t = useNumbersTranslations("Reviews");
  if (rating.count === 0 || rating.average === null) return null;
  const average = formatAverage(rating.average, locale);
  return (
    <a href={href} data-testid="rating-link" className={cn("inline-flex min-h-6 items-center gap-1.5 rounded-sm text-sm text-foreground-muted hover:text-foreground", className)}>
      <Stars value={rating.average} />
      <span className="font-semibold text-foreground tabular-nums">{average}</span>
      <span className="sr-only">{t("average", { average })}</span>
      <span aria-hidden="true">·</span>
      <span className="underline-offset-4 hover:underline">{t("count", { count: rating.count })}</span>
    </a>
  );
}
