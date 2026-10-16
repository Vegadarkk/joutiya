import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Breadcrumb of the listing page: home > category > subcategory > city > listing. The intermediate
// steps open the search page filtered on them (phase 4 reads the same query names, SEARCH_QUERY).

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

export interface BreadcrumbItem {
  label: string;
  href?: ReturnType<typeof searchHref> | "/";
}

export function Breadcrumb({ items, current, className }: { items: BreadcrumbItem[]; current: string; className?: string }) {
  const t = useTranslations("ListingPage");
  return (
    <nav aria-label={t("breadcrumb")} className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-foreground-muted">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-1">
            {item.href ? (
              <Link href={item.href} prefetch={false} className="inline-flex min-h-11 items-center rounded-sm hover:text-foreground hover:underline hover:underline-offset-2 sm:min-h-0 sm:py-1">
                {item.label}
              </Link>
            ) : (
              <span>{item.label}</span>
            )}
            <ChevronRight className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
          </li>
        ))}
        <li className="min-w-0 max-w-full">
          <span aria-current="page" className="block truncate text-foreground sm:max-w-[22rem]">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
