import { Baby, Building2, Car, Dumbbell, Handshake, Package, PawPrint, Shirt, Smartphone, Sofa, Wheat, Wrench, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { CATEGORIES } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// The twelve categories on the home page (design D21), each a small doorway of the logo (pointed
// arch on a gold threshold) linking to its SEO page /c/{category} (L4). One scrolling row on
// phones, the whole arcade in one line from xl (twelve labels do not fit a 1024 px row). Below xl
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
  divers: Package,
};

export function categoryHref(categoryId: string): string {
  return `/c/${categoryId}`;
}

export function CategoryGrid({ className }: { className?: string }) {
  const t = useTranslations("Home.categories");
  const names = useTranslations("Categories");
  type Key = Parameters<typeof names>[0];
  return (
    <section aria-labelledby="home-categories" data-testid="home-categories" className={cn("flex flex-col gap-4", className)}>
      <h2 id="home-categories" className="text-xl font-semibold">
        {t("title")}
      </h2>
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-1 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 xl:mx-0 xl:grid xl:grid-cols-12 xl:overflow-visible xl:px-0 [&::-webkit-scrollbar]:hidden">
        {CATEGORIES.map((category) => {
          const Icon = ICONS[category.id] ?? Package;
          return (
            <li key={category.id} className="w-[max(5.75rem,calc((100%_-_0.75rem)/3.5))] shrink-0 snap-start sm:w-[max(5.75rem,calc((100%_-_1.5rem)/6.5))] xl:w-auto">
              <Link
                href={categoryHref(category.id)}
                prefetch={false}
                data-category={category.id}
                className="group flex h-full flex-col items-center gap-2 rounded-md px-1 pt-1 pb-2 text-center focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <span className="arch threshold flex h-[4.5rem] w-16 items-end justify-center bg-surface-brand pb-3.5 text-structure transition-colors duration-200 ease-door group-hover:bg-structure group-hover:text-structure-foreground dark:text-gold-300 dark:group-hover:text-gold-300">
                  <Icon className="size-6" aria-hidden="true" strokeWidth={1.75} />
                </span>
                <span className="line-clamp-2 text-sm leading-tight font-medium text-balance">{names(`${category.id}.name` as Key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
