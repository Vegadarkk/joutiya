import { CarFront, TreePalm } from "lucide-react";
import { useTranslations } from "next-intl";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { canonicalSearchParams, searchPath } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// « Louer une voiture » and « Location de vacances » at the top of the home map's panel on phones
// (UX audit option B, owner 29 Oct 2026): rentals were only reached by scrolling under the
// listings. From md up the header's « Louer » menu carries them.

const RENT_CAR = searchPath(canonicalSearchParams({ category: "vehicules", subcategory: RENTAL_SUBCATEGORY }));
const HOLIDAY = searchPath(canonicalSearchParams({ category: "immobilier", subcategory: "location-vacances" }));

const TILE =
  "flex min-h-12 min-w-0 items-center gap-2.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm leading-tight font-medium text-balance transition-colors duration-150 ease-door hover:bg-surface-muted";
const ICON = "flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300";

export function RentShortcuts({ className }: { className?: string }) {
  const t = useTranslations("Home.rent");
  const rental = useTranslations("Rental.home");
  const names = useTranslations("Categories");
  return (
    <nav aria-label={t("label")} data-testid="home-rent-shortcuts" className={cn("grid grid-cols-2 gap-2 px-2 md:hidden", className)}>
      <Link href={RENT_CAR} prefetch={false} className={TILE}>
        <span className={ICON}>
          <CarFront aria-hidden="true" className="size-4" />
        </span>
        {rental("title")}
      </Link>
      <Link href={HOLIDAY} prefetch={false} className={TILE}>
        <span className={ICON}>
          <TreePalm aria-hidden="true" className="size-4" />
        </span>
        {names("immobilier.sub.location-vacances")}
      </Link>
    </nav>
  );
}
