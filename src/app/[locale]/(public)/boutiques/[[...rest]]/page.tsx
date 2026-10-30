import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BadgeCheck, MapPin, Store } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EmptyState } from "@/components/feedback/empty-state";
import { Container } from "@/components/layout/container";
import { LandingBreadcrumb, SubcategoryChips, type LandingChip, type LandingCrumb } from "@/components/seo/landing";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { ShopBand, ShopEmblem } from "@/components/pro/shop-emblem";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { alternates } from "@/lib/i18n/metadata";
import { listDirectoryShops } from "@/lib/pro/directory";
import { DIRECTORY_CITY_CHIPS, countByCity, countBySector, directoryPath, filterShops, parseDirectorySegments, sortShops, type DirectoryFilter } from "@/lib/pro/directory-view";
import { PRO_SECTORS } from "@/lib/pro/profile-schema";
import { PRO_LANDING_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// The directory of verified shops and agencies (owner's choice of 30 Oct 2026, UX journeys
// counter-review): /boutiques, /boutiques/ville/{city}, /boutiques/activite/{activity} and both.
// ISR like the category landings: the filters are path segments, the page holds no client state,
// an unknown segment is a cached 404. Every shop listed has its storefront shown (verified, active
// or in grace, with a plan) and an owner with a public face; the example shops are labelled and
// listed last. The chips count the activities within the city and the cities within the activity.

export const revalidate = 300;
export const dynamicParams = true;

export function generateStaticParams(): { rest?: string[] }[] {
  return [];
}

type Params = Promise<{ locale: string; rest?: string[] }>;

const restKeyOf = (rest: string[] | undefined) => (rest ?? []).join("/");

/** One Firestore round trip per render, shared by generateMetadata and the page. */
const load = cache(async (restKey: string) => {
  const filter = parseDirectorySegments(restKey ? restKey.split("/") : []);
  if (!filter) return null;
  return { filter, shops: await listDirectoryShops() };
});

/** The translator and the H1 of a filter: "Agences immobilières à Casablanca". */
async function directoryLabels(locale: Locale, filter: DirectoryFilter) {
  const t = await getTranslations({ locale: numbersLocale(locale), namespace: "Directory" });
  const cityRecord = filter.city ? cityBySlug(filter.city) : undefined;
  const city = cityRecord ? cityName(cityRecord, locale) : undefined;
  const sector = filter.sector ? t(`sectors.${filter.sector}`) : undefined;
  const heading = sector && city ? t("titleSectorCity", { sector, city }) : sector ? sector : city ? t("titleCity", { city }) : t("title");
  return { t, heading };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, rest } = await params;
  const locale = pageLocale(value);
  const data = await load(restKeyOf(rest));
  if (!data) return {};
  const { t, heading } = await directoryLabels(locale, data.filter);
  const count = filterShops(data.shops, data.filter).length;
  return {
    title: t("metaTitle", { heading }),
    description: count > 0 ? t("metaDescription", { count }) : t("metaDescriptionEmpty"),
    alternates: alternates(locale, directoryPath(data.filter)),
    // An empty page has nothing to show search engines yet.
    ...(count > 0 ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function DirectoryPage({ params }: { params: Params }) {
  const { locale: value, rest } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const data = await load(restKeyOf(rest));
  if (!data) notFound();
  const { filter, shops } = data;
  const [{ t, heading }, seo] = await Promise.all([directoryLabels(locale, filter), getTranslations({ locale, namespace: "Seo" })]);
  const results = sortShops(filterShops(shops, filter), locale);

  // Facets: the activities counted within the city, the cities within the activity.
  const inCity = filterShops(shops, { city: filter.city });
  const inSector = filterShops(shops, { sector: filter.sector });
  const bySector = countBySector(inCity);
  const sectorChips: LandingChip[] = [
    { id: "all", label: t("allActivities"), count: inCity.length, href: directoryPath({ city: filter.city }), current: !filter.sector },
    ...PRO_SECTORS.filter((sector) => bySector[sector] > 0 || sector === filter.sector).map((sector) => ({
      id: sector,
      label: t(`sectors.${sector}`),
      count: bySector[sector],
      href: directoryPath({ city: filter.city, sector }),
      current: filter.sector === sector,
    })),
  ];
  const cities = countByCity(inSector);
  const shown = cities.slice(0, DIRECTORY_CITY_CHIPS);
  if (filter.city && !shown.some((entry) => entry.city === filter.city)) shown.push({ city: filter.city, count: cities.find((entry) => entry.city === filter.city)?.count ?? 0 });
  const cityChips: LandingChip[] = [
    { id: "all", label: t("allCities"), count: inSector.length, href: directoryPath({ sector: filter.sector }), current: !filter.city },
    ...shown.flatMap((entry) => {
      const city = cityBySlug(entry.city);
      return city ? [{ id: entry.city, label: cityName(city, locale), count: entry.count, href: directoryPath({ city: entry.city, sector: filter.sector }), current: filter.city === entry.city }] : [];
    }),
  ];
  const filtered = Boolean(filter.city || filter.sector);
  const crumbs: LandingCrumb[] = [{ label: seo("home"), href: "/" }, ...(filtered ? [{ label: t("crumb"), href: directoryPath({}) }, { label: heading }] : [{ label: t("crumb") }])];
  const none = shops.length === 0;
  const countLabel = results.length > 0 ? t("count", { count: results.length }) : t("countZero");

  return (
    <Container className="flex flex-col gap-8 py-8 md:gap-10 md:py-12">
      <LandingBreadcrumb steps={crumbs} />
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div className="flex max-w-2xl flex-col gap-3">
          <p className="text-sm font-semibold tracking-wide text-structure uppercase dark:text-gold-300">{t("eyebrow")}</p>
          <h1 className="text-3xl font-semibold text-balance md:text-4xl">{heading}</h1>
          <p className="text-pretty text-foreground-muted md:text-lg">{t("lead")}</p>
        </div>
        <Link href={PRO_LANDING_PATH} prefetch={false} className={cn(buttonVariants({ variant: "structure", size: "md" }), "w-fit shrink-0")}>
          <Store aria-hidden="true" />
          {t("open")}
        </Link>
      </header>

      {none ? null : (
        <div className="flex flex-col gap-3">
          <SubcategoryChips chips={sectorChips} label={t("activities")} />
          <SubcategoryChips chips={cityChips} label={t("cities")} />
        </div>
      )}

      <section aria-label={countLabel} className="flex flex-col gap-5">
        {results.length > 0 ? (
          <>
            <h2 className="text-lg font-semibold text-foreground-muted">{countLabel}</h2>
            <ul data-testid="directory-list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((shop) => {
                const city = cityBySlug(shop.citySlug);
                return (
                  <li key={shop.proId} className="min-w-0">
                    {/* The whole card leads to the storefront: the name's link stretches over it. */}
                    <article className="relative flex h-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-surface px-5 pb-5 transition-[border-color,box-shadow] duration-150 ease-door focus-within:border-foreground/40 hover:border-foreground/40 hover:shadow-sm">
                      <ShopBand name={shop.name} className="-mx-5 w-auto" />
                      <div className="-mt-9 flex items-end gap-4">
                        <ShopEmblem name={shop.name} sector={shop.sector} />
                        <div className="flex min-w-0 flex-col gap-1 pb-0.5">
                          <h3 className="text-lg leading-tight font-semibold">
                            <Link href={`/boutique/${shop.segment}`} prefetch={false} dir="auto" className="break-words after:absolute after:inset-0 after:rounded-lg">
                              {shop.name}
                            </Link>
                          </h3>
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-foreground-muted">
                            <span>{t(`sectorOne.${shop.sector}`)}</span>
                            {city ? (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                                {cityName(city, locale)}
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                      {shop.excerpt ? (
                        <p dir="auto" className="line-clamp-3 text-sm text-pretty text-foreground-muted">
                          {shop.excerpt}
                        </p>
                      ) : null}
                      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1 text-sm">
                        {shop.example ? (
                          <Badge variant="neutral">{t("badges.example")}</Badge>
                        ) : (
                          <Badge variant="featured">
                            <BadgeCheck className="size-3.5" aria-hidden="true" />
                            {shop.certified ? t("badges.certified") : t("badges.verified")}
                          </Badge>
                        )}
                        <span className="text-foreground-muted">{shop.listings > 0 ? t("listings", { count: shop.listings }) : t("listingsNone")}</span>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          </>
        ) : none ? (
          <EmptyState
            title={t("none.title")}
            action={
              <Link href={PRO_LANDING_PATH} prefetch={false} className={buttonVariants({ variant: "primary", size: "md" })}>
                <Store aria-hidden="true" />
                {t("open")}
              </Link>
            }
          >
            {t("none.body")}
          </EmptyState>
        ) : (
          <EmptyState
            title={t("empty.title")}
            action={
              <Link href={directoryPath({})} prefetch={false} className={buttonVariants({ variant: "outline", size: "md" })}>
                {t("empty.all")}
              </Link>
            }
          >
            {t("empty.body")}
          </EmptyState>
        )}
      </section>
    </Container>
  );
}
