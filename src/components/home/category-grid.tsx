import { Baby, BriefcaseBusiness, Building2, Car, Dumbbell, Handshake, Package, PawPrint, Shirt, Smartphone, Sofa, Wheat, Wrench, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { CATEGORIES } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { RailScroller } from "./rail-scroller";

// The thirteen categories on the home page (design D21), each a small doorway of the logo (pointed
// arch on a gold threshold) linking to its SEO page /c/{category} (L4). One scrolling row on
// phones, the whole arcade in one line from xl (thirteen labels do not fit a 1024 px row). Below xl
// the tiles share the row width so that part of the next tile always shows at the edge (about 3.5
// tiles on phones, 6.5 on tablets and small laptops): the row reads as scrollable.

/** Same icons as the listing wizard (post/category-picker.tsx, a client module: not importable here). */
const ICONS: Record<string, LucideIcon> = {
  vehicules: Car,
  immobilier: Building2,
  electronique: Smartphone,
  "maison-jardin": Sofa,
  mode: Shirt,
  terroir: Wheat,
  famille: Baby,
  loisirs: Dumbbell,
  animaux: PawPrint,
  "materiel-pro": Wrench,
  services: Handshake,
  emploi: BriefcaseBusiness,
  divers: Package,
};

export function categoryHref(categoryId: string): string {
  return `/c/${categoryId}`;
}

export interface CategoryGridProps {
  /**
   * "grid": the home page's arcade (list view). "rail": the same doorways, smaller, in one
   * scrolling line of the home map's panel (Carte vivante, lot 3), under a quieter heading.
   */
  variant?: "grid" | "rail";
  className?: string;
}

export function CategoryGrid({ variant = "grid", className }: CategoryGridProps) {
  const t = useTranslations("Home.categories");
  const names = useTranslations("Categories");
  type Key = Parameters<typeof names>[0];
  const rail = variant === "rail";
  const headingId = rail ? "home-category-rail" : "home-categories";
  const list = (
    <ul
      className={cn(
        "flex snap-x gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        rail
          ? "scroll-px-2 ps-2 pe-8 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-2.5rem),transparent)]"
          : "-mx-4 scroll-px-4 px-4 pb-2 sm:-mx-6 sm:scroll-px-6 sm:px-6 xl:mx-0 xl:grid xl:grid-cols-13 xl:overflow-visible xl:px-0",
      )}
    >
      {CATEGORIES.map((category) => {
        const Icon = ICONS[category.id] ?? Package;
        return (
          <li
            key={category.id}
            className={cn(
              "shrink-0 snap-start",
              rail ? "w-[4.75rem]" : "w-[max(5.75rem,calc((100%_-_0.75rem)/3.5))] sm:w-[max(5.75rem,calc((100%_-_1.5rem)/6.5))] xl:w-auto",
            )}
          >
            <Link
              href={categoryHref(category.id)}
              prefetch={false}
              data-category={category.id}
              className={cn(
                "group flex h-full flex-col items-center rounded-md px-1 text-center focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
                rail ? "gap-1.5 pt-1 pb-1.5" : "gap-2 pt-1 pb-2",
              )}
            >
              <span
                className={cn(
                  "arch threshold flex items-end justify-center bg-surface-brand text-structure transition-colors duration-200 ease-door group-hover:bg-structure group-hover:text-structure-foreground dark:text-gold-300 dark:group-hover:text-gold-300",
                  rail ? "h-[3.25rem] w-12 pb-2.5" : "h-[4.5rem] w-16 pb-3.5",
                )}
              >
                <Icon className={rail ? "size-5" : "size-6"} aria-hidden="true" strokeWidth={1.75} />
              </span>
              <span className={cn("line-clamp-2 leading-tight font-medium text-balance", rail ? "text-xs" : "text-sm")}>{names(`${category.id}.name` as Key)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return (
    <section aria-labelledby={headingId} data-testid={rail ? "home-category-rail" : "home-categories"} className={cn("flex flex-col", rail ? "gap-2" : "gap-4", className)}>
      <h2 id={headingId} className={rail ? "px-2 text-sm font-semibold text-foreground-muted" : "text-xl font-semibold"}>
        {t("title")}
      </h2>
      {rail ? (
        <RailScroller previous={t("previous")} next={t("next")}>
          {list}
        </RailScroller>
      ) : (
        list
      )}
    </section>
  );
}
