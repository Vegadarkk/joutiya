import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import { cityName, type City } from "@/config/regions";
import { Link } from "@/i18n/navigation";
import { groupDigits } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// Building blocks of the category landing pages (design D15). Server components, no client state:
// the HTML is shared by every visitor (ISR, Cloudflare). Links never prefetch: prefetches count
// against the page-view limits (D14) and a page holds dozens of them.

/** Same grouping as prices and the search chips ("1 200"), in every locale. */
export function formatCount(count: number): string {
  return groupDigits(String(count)) || "0";
}

export interface LandingCrumb {
  label: string;
  /** Path without the locale; absent on the current page. */
  href?: string;
}

/** Home > category > subcategory > city; the last step is the page itself. */
export function LandingBreadcrumb({ steps, className }: { steps: readonly LandingCrumb[]; className?: string }) {
  const t = useTranslations("Seo");
  return (
    <nav aria-label={t("breadcrumb")} className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-foreground-muted">
        {steps.map((step, index) => (
          <li key={`${index}-${step.label}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden="true" /> : null}
            {step.href ? (
              <Link href={step.href} prefetch={false} className="inline-flex min-h-11 items-center rounded-sm hover:text-foreground hover:underline hover:underline-offset-2 sm:min-h-0 sm:py-1">
                {step.label}
              </Link>
            ) : (
              <span aria-current="page" className="block truncate text-foreground sm:max-w-[22rem]">
                {step.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface LandingChip {
  id: string;
  label: string;
  count: number;
  href: string;
  current?: boolean;
}

/** Subcategories of the scope with their counts: a scroll row on phones, wrapped on larger screens. */
export function SubcategoryChips({ chips, label }: { chips: readonly LandingChip[]; label: string }) {
  return (
    <nav aria-label={label} className="-mx-4 sm:mx-0">
      <ul className="flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-0">
        {chips.map((chip) => (
          <li key={chip.id} className="shrink-0 snap-start">
            <Link
              href={chip.href}
              prefetch={false}
              aria-current={chip.current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-150 ease-door",
                chip.current
                  ? "border-structure bg-structure text-structure-foreground"
                  : "border-border-strong bg-surface text-foreground hover:border-foreground/40 hover:bg-surface-muted",
              )}
            >
              {chip.label}
              <span className={cn("tabular-nums", chip.current ? "text-structure-foreground/75" : "text-foreground-muted")}>{formatCount(chip.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface LandingCityLink {
  city: City;
  count: number;
  href: string;
}

/** Internal links to the same scope in other cities (nearest first around a city). */
export function CityLinks({ links, locale, title, id }: { links: readonly LandingCityLink[]; locale: Locale; title: string; id: string }) {
  return (
    <nav aria-labelledby={id} className="flex flex-col gap-4 border-t border-border pt-8">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <ul className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-4">
        {links.map((link) => (
          <li key={link.city.slug} className="min-w-0 border-b border-border/70">
            <Link href={link.href} prefetch={false} className="group flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
              <span className="truncate text-foreground group-hover:underline group-hover:underline-offset-2">{cityName(link.city, locale)}</span>
              <span className="shrink-0 tabular-nums text-foreground-muted">{formatCount(link.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
