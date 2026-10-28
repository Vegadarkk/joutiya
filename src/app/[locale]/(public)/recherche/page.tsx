import type { ReactNode } from "react";
import type { Metadata } from "next";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { AdSlot } from "@/components/ads/ad-slot";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Container } from "@/components/layout/container";
import { SaveSearchButton } from "@/components/saved-searches/save-search-button";
import { ActiveFilterChips } from "@/components/search/active-filter-chips";
import { RentalDatesBar } from "@/components/rental/rental-dates-bar";
import { FeaturedRow, withoutFeatured } from "@/components/search/featured-row";
import { FiltersSheet } from "@/components/search/filters-sheet";
import { Pagination } from "@/components/search/pagination";
import { RefineChips } from "@/components/search/refine-chips";
import { ResultsGrid } from "@/components/search/results-grid";
import { SearchBar } from "@/components/search/search-bar";
import { SearchChallenge } from "@/components/search/search-challenge";
import { SearchEmpty } from "@/components/search/search-empty";
import { SearchError } from "@/components/search/search-error";
import { PendingBar, PendingRegion, SearchNavigationProvider } from "@/components/search/search-navigation";
import { SortSelect } from "@/components/search/sort-select";
import { infeedPositions } from "@/config/ads";
import { RENTAL_SUBCATEGORY, subcategoryAllowsAds } from "@/config/categories";
import { availablePromos, type HousePromo } from "@/config/house-promos";
import type { Locale } from "@/config/site";
import { PUBLIC_CLIENT_NAMESPACES, SEARCH_PAGE_CLIENT_NAMESPACES, pickMessages } from "@/i18n/client-messages";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { getFlags } from "@/lib/config/runtime";
import { parseSearchParams, SEARCH_MAX_TOTAL_HITS, SEARCH_PATH, searchPath } from "@/lib/search/params";
import type { SearchCard, SearchResponse } from "@/lib/search/types";
import { loadSearch, pageRequest, searchPageTitle } from "./search-state";

const favoriteAction = (card: SearchCard) => <FavoriteButton listingId={card.id} />;

// Search results (design §2 L3b, D2, D6-D8, D13). Dynamic: the query string is the whole state,
// rendered on the server from the engine; the filters only navigate (client islands). Same limits
// as /api/search: over them the page shows the Turnstile challenge instead of the results.
// noindex, follow (internal search; robots.txt also disallows it, D16).

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const title = await searchPageTitle(locale, parseSearchParams(await searchParams));
  // The canonical of the root layout points at the home page: never inherit it here.
  return { title, robots: { index: false, follow: true }, alternates: { canonical: `/${locale}${SEARCH_PATH}` } };
}

interface ResultsProps {
  response: SearchResponse;
  locale: Locale;
  /** L5 wiring point: SaveSearchButton (`params={response.params}`). */
  toolbarAction?: ReactNode;
  /** L5 wiring point: FavoriteButton on every card. */
  renderAction?: (card: SearchCard) => ReactNode;
  /** House promotions open now, for the ad slots. */
  promos: readonly HousePromo[];
}

/**
 * Ads only beside results (never an empty search, AF §8) whose every card may carry them, and never
 * under an adults-only subcategory filter (D6).
 */
function resultsAdsEligible(response: SearchResponse, organic: readonly SearchCard[]): boolean {
  if (organic.length === 0) return false;
  if (response.params.subcategory && !subcategoryAllowsAds(response.params.subcategory)) return false;
  return response.hits.every((card) => subcategoryAllowsAds(card.subcategoryId ?? undefined));
}

function Results({ response, locale, toolbarAction, renderAction, promos }: ResultsProps) {
  const t = useTranslations("SearchPage");
  const { params, hits, featured } = response;
  const organic = withoutFeatured(hits, featured);
  const adsEligible = resultsAdsEligible(response, organic);
  const seed = `${searchPath(params)}:${response.page}`;
  return (
    <>
      <RefineChips params={params} facets={response.facets} />
      <div className="sticky top-16 z-30 -mx-4 border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:px-6 md:top-20">
        <div role="toolbar" aria-label={t("toolbar")} className="flex items-center gap-2">
          <FiltersSheet params={params} facets={response.facets} className="max-sm:gap-1.5 max-sm:px-3" />
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {toolbarAction}
            <SortSelect params={params} />
          </div>
        </div>
        <PendingBar className="absolute inset-x-0 bottom-0" />
      </div>
      <ActiveFilterChips params={params} locale={locale} />
      {params.subcategory === RENTAL_SUBCATEGORY ? <RentalDatesBar key={searchPath(params)} params={params} /> : null}
      {response.approximate ? (
        <ErrorBanner tone="info" title={t("approximate.title")}>
          {t("approximate.body")}
        </ErrorBanner>
      ) : null}
      <PendingRegion className="flex flex-col gap-8">
        {hits.length > 0 ? (
          <div className="flex flex-col gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:items-start">
            <div className="flex min-w-0 flex-col gap-8">
              <FeaturedRow cards={featured} locale={locale} renderAction={renderAction} />
              {organic.length > 0 ? (
                <section aria-labelledby="search-results-title">
                  <h2 id="search-results-title" className="sr-only">
                    {t("results")}
                  </h2>
                  <ResultsGrid
                    cards={organic}
                    locale={locale}
                    renderAction={renderAction}
                    priorityCount={featured.length > 0 ? 2 : 4}
                    className="xl:grid-cols-3"
                    inserts={{
                      after: infeedPositions(organic.length),
                      render: (after) => <AdSlot placement="search-infeed" eligible={adsEligible} promos={promos} seed={`${seed}:${after}`} />,
                    }}
                  />
                </section>
              ) : null}
              <Pagination params={params} page={response.page} totalPages={response.totalPages} total={response.total} className="pt-2" />
            </div>
            {/* Wide screens: a 300x600 column that follows the scroll under the sticky toolbar, when the
                window is tall enough to show the whole unit there (else it stays at the top). */}
            <div className="top-40 max-xl:hidden [@media(min-height:50rem)]:sticky">
              <AdSlot placement="search-aside" eligible={adsEligible} promos={promos} seed={seed} />
            </div>
          </div>
        ) : (
          <>
            <SearchEmpty params={params} locale={locale} outOfRange={response.total > 0} />
            <FeaturedRow cards={featured} locale={locale} renderAction={renderAction} />
          </>
        )}
      </PendingRegion>
    </>
  );
}

export default async function SearchPage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const query = parseSearchParams(await searchParams);
  const [outcome, flags] = await Promise.all([pageRequest().then((request) => loadSearch(query, request)), getFlags()]);
  const applied = outcome.kind === "results" ? outcome.response.params : query;
  // The count prints a number: Tarifit pages format it as French (no Intl data for "rif").
  const [t, title] = await Promise.all([getTranslations({ locale: numbersLocale(locale), namespace: "SearchPage" }), searchPageTitle(locale, applied)]);
  const total = outcome.kind === "results" ? outcome.response.total : 0;
  const promos = availablePromos(flags);

  // The public layout ships only the public client namespaces; the filters sheet and the save
  // dialog read more (src/i18n/client-messages.ts). A nested provider replaces, never merges.
  const messages = pickMessages(await getMessages({ locale }), [...PUBLIC_CLIENT_NAMESPACES, ...SEARCH_PAGE_CLIENT_NAMESPACES]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SearchNavigationProvider>
        <div className="border-b border-border bg-surface-brand/60">
          <Container className="py-4 sm:py-6">
            {/* Remounted per search: its fields start from the URL after every navigation. */}
            <SearchBar key={searchPath(applied)} params={applied} />
          </Container>
        </div>
        <Container className="flex flex-col gap-4 pt-6 pb-12 sm:gap-5 sm:pt-8 sm:pb-16">
          <header className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-balance break-words sm:text-3xl">{title}</h1>
            {outcome.kind === "results" ? (
              <p data-testid="search-count" aria-live="polite" className="text-foreground-muted">
                {total >= SEARCH_MAX_TOTAL_HITS ? t("countAtLeast", { count: SEARCH_MAX_TOTAL_HITS }) : t("count", { count: total })}
              </p>
            ) : null}
          </header>
          {outcome.kind === "results" ? (
            <Results
              response={outcome.response}
              locale={locale}
              toolbarAction={<SaveSearchButton params={outcome.response.params} />}
              renderAction={favoriteAction}
              promos={promos}
            />
          ) : outcome.kind === "challenge" ? (
            <SearchChallenge params={applied} />
          ) : (
            <SearchError kind={outcome.kind} retryAfter={outcome.kind === "rate_limited" ? outcome.retryAfter : undefined} />
          )}
        </Container>
      </SearchNavigationProvider>
    </NextIntlClientProvider>
  );
}
