import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { quietLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Breadcrumb of the listing page: home > category > subcategory > city > listing. The intermediate
// steps open the crawlable category landing pages (`landingHref`, phase 4 D15); `searchHref` builds the
// equivalent search page link (robots-disallowed, so never used for crawl paths).

/** Query names of the search page for the breadcrumb filters (to keep in step with phase 4). */
export const SEARCH_QUERY = { category: "categorie", subcategory: "sous-categorie", city: "ville" } as const;

export interface SearchFilters {
  category?: string;
  subcategory?: string;
  city?: string;
}

export function searchHref(filters: SearchFilters): { pathname: "/recherche"; query: Record<string, string> } {
  const query: Record<string, string> = {};
  if (filters.category) query[SEARCH_QUERY.category] = filters.category;
  if (filters.subcategory) query[SEARCH_QUERY.subcategory] = filters.subcategory;
  if (filters.city) query[SEARCH_QUERY.city] = filters.city;
  return { pathname: "/recherche", query };
}

/** Category landing page `/c/{category}[/{subcategory}][/{city}]` (src/lib/search/seo.ts `seoPath`). */
export function landingHref(filters: SearchFilters & { category: string }): `/c/${string}` {
  return `/c/${[filters.category, filters.subcategory, filters.city].filter(Boolean).join("/")}`;
}

export interface BreadcrumbItem {
  label: string;
  href?: ReturnType<typeof searchHref> | ReturnType<typeof landingHref> | "/";
}

export function Breadcrumb({ items, current, className }: { items: BreadcrumbItem[]; current: string; className?: string }) {
  const t = useTranslations("ListingPage");
  return (
    <nav aria-label={t("breadcrumb")} className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-foreground-muted">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-1">
            {item.href ? (
              <Link href={item.href} prefetch={false} className={cn("inline-flex min-h-11 items-center rounded-sm hover:text-foreground sm:min-h-0 sm:py-1", quietLinkClassName)}>
                {item.label}
              </Link>
            ) : (
              <span>{item.label}</span>
            )}
            {/* On a phone the trail ends with the last parent: the title stands right below, as the
                heading, and would otherwise take a second line (UX audit). */}
            <ChevronRight className={cn("size-3.5 shrink-0 rtl:-scale-x-100", index === items.length - 1 && "max-sm:hidden")} aria-hidden="true" />
          </li>
        ))}
        <li className="hidden min-w-0 max-w-full sm:block">
          <span aria-current="page" dir="auto" className="block truncate text-foreground sm:max-w-[22rem]">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
