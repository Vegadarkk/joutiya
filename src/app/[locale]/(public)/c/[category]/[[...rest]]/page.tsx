import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { EmptyState } from "@/components/feedback/empty-state";
import { Container } from "@/components/layout/container";
import { JsonLd } from "@/components/listing/json-ld";
import { FeaturedRow, withoutFeatured } from "@/components/search/featured-row";
import { ResultsGrid } from "@/components/search/results-grid";
import { CityLinks, LandingBreadcrumb, SubcategoryChips, type LandingChip, type LandingCrumb } from "@/components/seo/landing";
import { Button } from "@/components/ui/button";
import { categoryById } from "@/config/categories";
import { cityBySlug, cityName } from "@/config/regions";
import { CANONICAL_ORIGIN, SITE_NAME, LOCALE_TAGS, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { alternates } from "@/lib/i18n/metadata";
import { SEARCH_PATH, searchQueryObject } from "@/lib/search/params";
import { cityLinks, resolveSeoSegments, SEO_PAGE_SIZE, seoCounts, seoPath, seoSearchParams, seoVerdict, type SeoTarget } from "@/lib/search/seo";
import { runSearch } from "@/lib/search/service";
import { breadcrumbJsonLd } from "@/lib/seo/jsonld";
import type { SearchCard } from "@/lib/search/types";

const favoriteAction = (card: SearchCard) => <FavoriteButton listingId={card.id} />;

// Category landing pages (design D15): /c/{category}, /c/{category}/{subcategory|city},
// /c/{category}/{subcategory}/{city}. ISR on first visit, kept 10 minutes; segments are checked
// against the config before any engine call (a cached 404 costs nothing, an engine call per garbage
// URL would). No query string (the proxy 308s it away), no loading.tsx above: notFound() answers a
// real 404. Search down: the render throws and Next keeps serving the last good page (D2).

export const revalidate = 600;
export const dynamicParams = true;

export function generateStaticParams(): { category: string; rest?: string[] }[] {
  return [];
}

type Params = Promise<{ locale: string; category: string; rest?: string[] }>;

/** One engine round trip pair per render, shared by generateMetadata and the page. */
const load = cache(async (category: string, restKey: string) => {
  const target = resolveSeoSegments(category, restKey ? restKey.split("/") : []);
  if (!target) return null;
  const [response, counts] = await Promise.all([
    runSearch(seoSearchParams(target), { featured: true, facets: false, hitsPerPage: SEO_PAGE_SIZE }),
    seoCounts(target),
  ]);
  const total = Math.max(counts.total, response.total);
  return { target, response, counts, total, verdict: seoVerdict(target, total, counts.indexable) };
});

interface Labels {
  category: string;
  subcategory?: string;
  city?: string;
  /** H1: "Voitures à Casablanca". */
  heading: string;
}

async function labelsOf(locale: Locale, target: SeoTarget): Promise<Labels> {
  const [t, names] = await Promise.all([getTranslations({ locale: numbersLocale(locale), namespace: "Seo" }), getTranslations({ locale, namespace: "Categories" })]);
  type CategoryKey = Parameters<typeof names>[0];
  const category = names(`${target.category}.name` as CategoryKey);
  const subcategory = target.subcategory ? names(`${target.category}.sub.${target.subcategory}` as CategoryKey) : undefined;
  const cityRecord = target.city ? cityBySlug(target.city) : undefined;
  const city = cityRecord ? cityName(cityRecord, locale) : undefined;
  let heading: string;
  if (subcategory && city) heading = t("heading.subcategoryCity", { subcategory, city });
  else if (subcategory) heading = t("heading.subcategory", { subcategory });
  else if (city) heading = t("heading.categoryCity", { category, city });
  else heading = t("heading.category", { category });
  return { category, subcategory, city, heading };
}

const restKeyOf = (rest: string[] | undefined) => (rest ?? []).join("/");

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, category, rest } = await params;
  const locale = pageLocale(value);
  const data = await load(category, restKeyOf(rest));
  if (!data || data.verdict === "notFound") return {};
  const [t, labels] = await Promise.all([getTranslations({ locale: numbersLocale(locale), namespace: "Seo" }), labelsOf(locale, data.target)]);
  const title = t("metaTitle", { heading: labels.heading });
  const description = data.total > 0 ? t("metaDescription", { heading: labels.heading, count: data.total }) : t("metaDescriptionEmpty", { heading: labels.heading });
  const path = seoPath(data.target);
  return {
    title,
    description,
    alternates: alternates(locale, path),
    openGraph: { type: "website", siteName: SITE_NAME, locale: LOCALE_TAGS[locale].replace("-", "_"), url: `/${locale}${path}`, title, description },
    twitter: { card: "summary", title, description },
    // Thin pages stay reachable and pass their links on, out of the index (D15).
    ...(data.verdict === "noindex" ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function CategoryLandingPage({ params }: { params: Params }) {
  const { locale: value, category, rest } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const data = await load(category, restKeyOf(rest));
  if (!data || data.verdict === "notFound") notFound();

  const { target, response, counts, total } = data;
  const recent = withoutFeatured(response.hits, response.featured);
  const [t, names, labels] = await Promise.all([
    getTranslations({ locale: numbersLocale(locale), namespace: "Seo" }),
    getTranslations({ locale, namespace: "Categories" }),
    labelsOf(locale, target),
  ]);
  type CategoryKey = Parameters<typeof names>[0];
  const path = seoPath(target);

  // Home > category > subcategory > city; the last step is this page (same trail in JSON-LD).
  const trail = [
    { label: t("home"), path: "" },
    { label: labels.category, path: seoPath({ category: target.category }) },
    ...(labels.subcategory ? [{ label: labels.subcategory, path: seoPath({ category: target.category, subcategory: target.subcategory }) }] : []),
    ...(labels.city ? [{ label: labels.city, path }] : []),
  ];
  const steps: LandingCrumb[] = trail.map((step, index) => (index === trail.length - 1 ? { label: step.label } : { label: step.label, href: step.path || "/" }));
  const jsonLd = breadcrumbJsonLd(trail.map((step) => ({ name: step.label, url: `${CANONICAL_ORIGIN}/${locale}${step.path}` })));

  const subcategoryTotal = Object.values(counts.subcategories).reduce((sum, count) => sum + count, 0);
  const chips: LandingChip[] = [
    { id: "all", label: t("allChip"), count: subcategoryTotal, href: seoPath({ category: target.category, city: target.city }), current: !target.subcategory },
    ...(categoryById(target.category)?.subcategories ?? [])
      .filter((sub) => (counts.subcategories[sub.id] ?? 0) > 0)
      .map((sub) => ({
        id: sub.id,
        label: names(`${target.category}.sub.${sub.id}` as CategoryKey),
        count: counts.subcategories[sub.id] ?? 0,
        href: seoPath({ category: target.category, subcategory: sub.id, city: target.city }),
        current: sub.id === target.subcategory,
      })),
  ];
  const scope = labels.subcategory ?? labels.category;
  const cities = cityLinks(counts.cities, target.city).map(({ city, count }) => ({ city, count, href: seoPath({ ...target, city: city.slug }) }));
  const search = { pathname: SEARCH_PATH, query: searchQueryObject(seoSearchParams(target)) };
  const seeLabel = total === 1 ? t("seeOne") : t("seeAll", { count: total });

  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      <Container className="flex flex-col gap-8 pt-3 pb-12 sm:pt-5 lg:gap-10 lg:pb-16">
        <div className="flex flex-col gap-4">
          <LandingBreadcrumb steps={steps} />
          <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="text-3xl font-semibold text-balance break-words sm:text-4xl">{labels.heading}</h1>
              {total > 0 ? <p className="text-foreground-muted text-pretty">{t("lead", { count: total })}</p> : null}
            </div>
            {total > 0 ? (
              <Button asChild size="lg" className="self-start sm:self-auto">
                <Link href={search} prefetch={false}>
                  {seeLabel}
                </Link>
              </Button>
            ) : null}
          </header>
        </div>

        {chips.length > 1 ? <SubcategoryChips chips={chips} label={t("subcategoriesLabel")} /> : null}

        {response.featured.length > 0 ? <FeaturedRow cards={response.featured} locale={locale} renderAction={favoriteAction} /> : null}

        {recent.length > 0 ? (
          <section aria-labelledby="landing-recent" className="flex flex-col gap-5">
            <h2 id="landing-recent" className="text-xl font-semibold">
              {t("recentTitle")}
            </h2>
            <ResultsGrid cards={recent} locale={locale} priorityCount={4} renderAction={favoriteAction} />
            {total > response.hits.length ? (
              <div className="flex justify-center pt-2">
                <Button asChild variant="outline" size="lg">
                  <Link href={search} prefetch={false}>
                    {seeLabel}
                  </Link>
                </Button>
              </div>
            ) : null}
          </section>
        ) : (
          <EmptyState
            title={t("emptyTitle")}
            action={
              <Button asChild>
                <Link href="/deposer" prefetch={false}>
                  {t("post")}
                </Link>
              </Button>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        )}

        {cities.length > 0 ? <CityLinks id="landing-cities" links={cities} locale={locale} title={target.city ? t("nearbyTitle", { scope }) : t("citiesTitle", { scope })} /> : null}
      </Container>
    </>
  );
}
