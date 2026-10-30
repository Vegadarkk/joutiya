import { CarFront, ScrollText, ShoppingBag, TreePalm } from "lucide-react";
import { useTranslations } from "next-intl";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { canonicalSearchParams, searchPath } from "@/lib/search/params";
import { DIRECTORY_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// The home page's own doors to what the category row carries on the other pages (the home shows
// its categories itself, in its arcade or its rail, and has no row): the directory of verified
// shops (« Boutiques des Pros », the new and the agencies beside the second-hand of the listings)
// and the guide of the administrative procedures (« Démarches »), owner's request of 30 Oct 2026.
// In the home map's panel on phones, first, the two rental searches (UX audit option B, owner
// 29 Oct 2026: rentals were only reached by scrolling under the listings; from md the header's
// « Louer » menu carries them).

const RENT_CAR = searchPath(canonicalSearchParams({ category: "vehicules", subcategory: RENTAL_SUBCATEGORY }));
const HOLIDAY = searchPath(canonicalSearchParams({ category: "immobilier", subcategory: "location-vacances" }));

const TILE =
  "flex min-h-12 min-w-0 items-center gap-2.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm leading-tight font-medium text-balance transition-colors duration-150 ease-door hover:bg-surface-muted";
const ICON = "flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300";

export interface HomeShortcutsProps {
  /** The map panel's tiles: tighter, the rental searches first on phones, no hint under the titles. */
  compact?: boolean;
  className?: string;
}

export function HomeShortcuts({ compact = false, className }: HomeShortcutsProps) {
  const t = useTranslations("Home.shortcuts");
  const rental = useTranslations("Rental.home");
  const names = useTranslations("Categories");
  const door = (href: string, Icon: typeof ShoppingBag, title: string, hint: string, testId: string) => (
    <Link href={href} prefetch={false} data-testid={testId} className={cn(TILE, !compact && "sm:px-4 sm:py-3")}>
      <span className={ICON}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{title}</span>
        {compact ? null : <span className="text-xs font-normal text-foreground-muted max-sm:hidden">{hint}</span>}
      </span>
    </Link>
  );
  return (
    <nav aria-label={t("label")} data-testid="home-shortcuts" className={cn("grid grid-cols-2 gap-2", compact ? "px-2" : "sm:gap-3 lg:max-w-3xl", className)}>
      {compact ? (
        <>
          <Link href={RENT_CAR} prefetch={false} className={cn(TILE, "md:hidden")}>
            <span className={ICON}>
              <CarFront aria-hidden="true" className="size-4" />
            </span>
            {rental("title")}
          </Link>
          <Link href={HOLIDAY} prefetch={false} className={cn(TILE, "md:hidden")}>
            <span className={ICON}>
              <TreePalm aria-hidden="true" className="size-4" />
            </span>
            {names("immobilier.sub.location-vacances")}
          </Link>
        </>
      ) : null}
      {door(DIRECTORY_PATH, ShoppingBag, t("shops"), t("shopsHint"), "home-shops")}
      {door("/demarches", ScrollText, t("guide"), t("guideHint"), "home-guide")}
    </nav>
  );
}
