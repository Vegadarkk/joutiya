import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { AdSlot } from "@/components/ads/ad-slot";
import { ExamplesHiddenNotice } from "@/components/examples/examples-controls";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Container } from "@/components/layout/container";
import { RentalDatesBar } from "@/components/rental/rental-dates-bar";
import { SaveSearchButton } from "@/components/saved-searches/save-search-button";
import { ActiveFilterChips } from "@/components/search/active-filter-chips";
import { FeaturedHeading, FeaturedRow, withoutFeatured } from "@/components/search/featured-row";
import { FiltersSheet } from "@/components/search/filters-sheet";
import { DetailPanel } from "@/components/search/map/detail-panel";
import { HeaderSearchBridge, PanelHandle, RowsArea, SheetHandle, ViewToggle } from "@/components/search/map/map-controls";
import { mapListingLabels } from "@/components/search/map/map-labels";
import { buildMapListings, type MapListing } from "@/components/search/map/map-listings";
import { MapFailedNotice, MapStage } from "@/components/search/map/map-stage";
import { PanelLegal } from "@/components/search/map/panel-legal";
import { ResultRows } from "@/components/search/map/result-rows";
import { ListViewOnly, SearchMapRoot } from "@/components/search/map/search-map-root";
import { Pagination } from "@/components/search/pagination";
import { RefineChips } from "@/components/search/refine-chips";
import { ResultsGrid } from "@/components/search/results-grid";
import { SearchChallenge } from "@/components/search/search-challenge";
import { SearchEmpty } from "@/components/search/search-empty";
import { SearchError } from "@/components/search/search-error";
import { PendingBar, PendingRegion, SearchNavigationProvider } from "@/components/search/search-navigation";
import { SortSelect } from "@/components/search/sort-select";
import { UnderstoodChips, understoodChipKeys } from "@/components/search/understood-chips";
import { infeedPositions } from "@/config/ads";
import { datedRental, subcategoryAllowsAds } from "@/config/categories";
import { availablePromos, type HousePromo } from "@/config/house-promos";
import type { Locale } from "@/config/site";
import { PUBLIC_CLIENT_NAMESPACES, SEARCH_PAGE_CLIENT_NAMESPACES, pickMessages } from "@/i18n/client-messages";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { searchMapConfig } from "@/lib/config/public";
import type { PublicMapConfig } from "@/lib/config/public-types";
import { getFlags } from "@/lib/config/runtime";
import { getLegalConfig } from "@/lib/legal/config";
import { interpretSearch, type AppliedSearch } from "@/lib/search/interpret";
import { parseSearchParams, SEARCH_MAX_TOTAL_HITS, SEARCH_PATH, searchPath } from "@/lib/search/params";
import type { SearchCard, SearchResponse } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { loadSearch, pageRequest, searchPageTitle } from "./search-state";

// Search results (design §2 L3b, D2, D6-D8, D13), map first (Carte vivante, lot 2). Dynamic: the
// query string is the whole state, rendered on the server from the engine; the filters only
// navigate (client islands). Same limits as /api/search: over them the page shows the Turnstile
// challenge instead of the results. noindex, follow (internal search; robots.txt also disallows it).
//
// One server-rendered panel serves every view: the map view floats it over a full-bleed map
// (desktop: a list at the start side; phones: a bottom sheet), the list view lays the card grid out
// in the page, and without script the rows are the list. The header pill is the page's search field
// (HeaderSearchBridge): words and place prefilled, the other filters carried.
//
// « Chercher en parlant » (lot 4): words without `brut=1` go through the rule-based interpreter
// (src/lib/search/interpret) before the search; the filters it understood and the URL leaves free
// apply, the rest of the words are searched, and the understood items show as chips. Rendered in
// place, no redirect: the URL keeps the sentence as typed (the pill shows it, a reload or a shared
// link reads it the same way, the interpreter being deterministic) and the request costs one
// search, under the same limits, challenge and error states. A chip's × or « Chercher le texte
// exact » leads to an ordinary URL with `brut=1`, which is never interpreted.

const favoriteAction = (card: SearchCard) => <FavoriteButton listingId={card.id} />;
const rowFavorite = (listing: MapListing) => <FavoriteButton listingId={listing.id} />;

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const query = parseSearchParams(await searchParams);
  const title = await searchPageTitle(locale, interpretSearch(query)?.params ?? query);
  // The canonical of the root layout points at the home page: never inherit it here.
  return { title, robots: { index: false, follow: true }, alternates: { canonical: `/${locale}${SEARCH_PATH}` } };
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

interface ResultsProps {
  response: SearchResponse;
  locale: Locale;
  title: string;
  count: string;
  promos: readonly HousePromo[];
  map: PublicMapConfig | null;
  publisher: string;
  translators: ResultsTranslators;
  /** The understood words of a typed sentence (null: none, or `brut=1`). */
  interpreted: AppliedSearch | null;
}

/** Loaded by the page: Results stays a synchronous component (rendered alone in the unit tests). */
async function resultsTranslators(locale: Locale) {
  const [t, own, labels] = await Promise.all([
    getTranslations({ locale, namespace: "SearchPage" }),
    getTranslations({ locale, namespace: "SearchMap" }),
    mapListingLabels(locale),
  ]);
  return { t, own, labels };
}
type ResultsTranslators = Awaited<ReturnType<typeof resultsTranslators>>;

function Results({ response, locale, title, count, promos, map, publisher, translators, interpreted }: ResultsProps) {
  const { t, own, labels } = translators;
  const { params, hits, featured } = response;
  const organic = withoutFeatured(hits, featured);
  const adsEligible = resultsAdsEligible(response, organic);
  const seed = `${searchPath(params)}:${response.page}`;
  const serverView = map ? "map" : "list";
  const listings = buildMapListings({ featured, hits: organic, locale, media: mediaBaseUrl(), now: new Date(), labels });
  const cards = new Map([...hits, ...featured].map((each) => [each.id, each]));
  const featuredRows = listings.filter((listing) => listing.featured);
  const organicRows = listings.filter((listing) => !listing.featured);

  return (
    <SearchMapRoot serverView={serverView} map={map} listings={listings} params={params} className="flex flex-1 flex-col">
      <Container className="search-flow flex flex-col gap-4 pt-6 pb-12 sm:gap-5 sm:pt-8 sm:pb-16">
        <section id="search-panel" aria-labelledby="search-title" data-testid="search-panel" className="search-panel flex flex-col gap-4 sm:gap-5">
          <SheetHandle />
          <header className="search-panel-head flex flex-col gap-1">
            <h1 id="search-title" className="text-2xl font-semibold text-balance break-words sm:text-3xl">
              {title}
            </h1>
            <p data-testid="search-count" aria-live="polite" className="text-foreground-muted">
              {count}
            </p>
            {/* In the head: the panel's own padding on the map, the page flow in the list. */}
            {interpreted ? <UnderstoodChips interpreted={interpreted} locale={locale} className="mt-2 pb-1" /> : null}
          </header>
          <div
            role="toolbar"
            aria-label={t("toolbar")}
            className="search-toolbar sticky top-16 z-30 -mx-4 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-6 sm:px-6 md:top-20"
          >
            <div className="search-toolbar-scroll flex min-w-0 flex-1 items-center gap-2">
              <FiltersSheet params={params} facets={response.facets} className="shrink-0 max-sm:gap-1.5 max-sm:px-3" />
              <ActiveFilterChips params={params} locale={locale} hide={understoodChipKeys(interpreted)} className="search-toolbar-chips" />
            </div>
            <ViewToggle />
            <PendingBar className="absolute inset-x-0 bottom-0" />
          </div>
          <div className="search-panel-tools flex flex-wrap items-center gap-2">
            <RefineChips params={params} facets={response.facets} className="search-refine w-full" />
            <div className="ms-auto flex min-w-0 items-center gap-2">
              <SaveSearchButton params={params} />
              <SortSelect params={params} />
            </div>
          </div>
          {datedRental(params.subcategory) ? <RentalDatesBar key={searchPath(params)} params={params} /> : null}
          {response.approximate ? (
            <ErrorBanner tone="info" title={t("approximate.title")}>
              {t("approximate.body")}
            </ErrorBanner>
          ) : null}
          <MapFailedNotice />
          <ExamplesHiddenNotice className="search-examples" />

          {hits.length === 0 ? <SearchEmpty params={params} locale={locale} outOfRange={response.total > 0} className="search-empty" /> : null}

          {/* Map view and its no-script list: the rows (no basemap configured: the grid only). */}
          {map ? (
            <>
              <RowsArea className="search-rows">
                <PendingRegion className="flex flex-col gap-3">
                  {hits.length === 0 && featuredRows.length > 0 ? <FeaturedHeading id="featured-rows-title" empty className="px-2 pt-1" /> : null}
                  {featuredRows.length > 0 ? <ResultRows listings={featuredRows} cards={cards} renderAction={rowFavorite} priorityCount={2} label={own("featuredRows")} /> : null}
                  {organicRows.length > 0 ? <ResultRows listings={organicRows} cards={cards} renderAction={rowFavorite} priorityCount={4} label={t("results")} /> : null}
                </PendingRegion>
              </RowsArea>
              <Pagination params={params} page={response.page} totalPages={response.totalPages} total={response.total} compact className="search-map-pagination" />
            </>
          ) : null}

          {/* List view: the card grid with its ad slots (rendered only there: no hidden ad). */}
          <ListViewOnly serverView={serverView}>
            <PendingRegion className="search-grid flex flex-col gap-8">
              {hits.length > 0 ? (
                <div className="flex flex-col gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:items-start">
                  <div className="flex min-w-0 flex-col gap-8">
                    <FeaturedRow cards={featured} locale={locale} renderAction={favoriteAction} />
                    {organic.length > 0 ? (
                      <section aria-labelledby="search-results-title">
                        <h2 id="search-results-title" className="sr-only">
                          {t("results")}
                        </h2>
                        <ResultsGrid
                          cards={organic}
                          locale={locale}
                          renderAction={favoriteAction}
                          priorityCount={map ? 0 : featured.length > 0 ? 2 : 4}
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
                <FeaturedRow cards={featured} locale={locale} renderAction={favoriteAction} empty />
              )}
            </PendingRegion>
          </ListViewOnly>
          <PanelLegal publisher={publisher} className="search-panel-legal" />
        </section>
      </Container>
      <PanelHandle />
      <MapStage />
      <DetailPanel />
    </SearchMapRoot>
  );
}

export default async function SearchPage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const query = parseSearchParams(await searchParams);
  const interpreted = interpretSearch(query);
  const searched = interpreted?.params ?? query;
  const [outcome, flags, legal] = await Promise.all([pageRequest().then((request) => loadSearch(searched, request)), getFlags(), getLegalConfig()]);
  const applied = outcome.kind === "results" ? outcome.response.params : searched;
  // The count prints a number: Tarifit pages format it as French (no Intl data for "rif").
  const [t, title, translators] = await Promise.all([
    getTranslations({ locale: numbersLocale(locale), namespace: "SearchPage" }),
    searchPageTitle(locale, applied),
    resultsTranslators(locale),
  ]);
  const total = outcome.kind === "results" ? outcome.response.total : 0;
  const promos = availablePromos(flags);

  // The public layout ships only the public client namespaces; the filters sheet and the save
  // dialog read more (src/i18n/client-messages.ts). A nested provider replaces, never merges.
  const messages = pickMessages(await getMessages({ locale }), [...PUBLIC_CLIENT_NAMESPACES, ...SEARCH_PAGE_CLIENT_NAMESPACES]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SearchNavigationProvider>
        {/* The pill holds the sentence as typed and the URL's own filters: sent again, it is read again. */}
        <HeaderSearchBridge params={interpreted ? query : applied} />
        {outcome.kind === "results" ? (
          <Results
            response={outcome.response}
            locale={locale}
            title={title}
            count={total >= SEARCH_MAX_TOTAL_HITS ? t("countAtLeast", { count: SEARCH_MAX_TOTAL_HITS }) : t("count", { count: total })}
            promos={promos}
            map={searchMapConfig()}
            publisher={legal.companyName}
            translators={translators}
            interpreted={interpreted}
          />
        ) : (
          <Container className="flex flex-col gap-4 pt-6 pb-12 sm:gap-5 sm:pt-8 sm:pb-16">
            <h1 className="text-2xl font-semibold text-balance break-words sm:text-3xl">{title}</h1>
            {outcome.kind === "challenge" ? (
              <SearchChallenge params={query} />
            ) : (
              <SearchError kind={outcome.kind} retryAfter={outcome.kind === "rate_limited" ? outcome.retryAfter : undefined} />
            )}
          </Container>
        )}
      </SearchNavigationProvider>
    </NextIntlClientProvider>
  );
}
