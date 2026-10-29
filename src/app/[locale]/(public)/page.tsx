import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { AdSlot } from "@/components/ads/ad-slot";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { CategoryGrid } from "@/components/home/category-grid";
import { FeaturedCarousel } from "@/components/home/featured-carousel";
import { HomePillars } from "@/components/home/home-pillars";
import { RentShortcuts } from "@/components/home/rent-shortcuts";
import { Container } from "@/components/layout/container";
import { RentCarLink } from "@/components/rental/rent-car-link";
import { RentCarModule } from "@/components/rental/rent-car-module";
import { FeaturedHeading, withoutFeatured } from "@/components/search/featured-row";
import { DetailPanel } from "@/components/search/map/detail-panel";
import { PanelHandle, RowsArea, SheetHandle, ViewToggle } from "@/components/search/map/map-controls";
import { mapListingLabels } from "@/components/search/map/map-labels";
import { buildMapListings, type MapListing } from "@/components/search/map/map-listings";
import { MapFailedNotice, MapStage } from "@/components/search/map/map-stage";
import { PanelLegal } from "@/components/search/map/panel-legal";
import { ResultRows } from "@/components/search/map/result-rows";
import { ListViewOnly, SearchMapRoot } from "@/components/search/map/search-map-root";
import { ResultsGrid } from "@/components/search/results-grid";
import { SearchNavigationProvider } from "@/components/search/search-navigation";
import { Button } from "@/components/ui/button";
import { WelcomeThreshold, welcomeTexts } from "@/components/welcome/welcome-threshold";
import { availablePromos } from "@/config/house-promos";
import { HOME_PAGE_CLIENT_NAMESPACES, PUBLIC_CLIENT_NAMESPACES, pickMessages } from "@/i18n/client-messages";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { searchMapConfig } from "@/lib/config/public";
import { getFlags } from "@/lib/config/runtime";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";
import { FEATURED_HOME_SLOTS } from "@/lib/search/featured";
import { SEARCH_PATH } from "@/lib/search/params";
import { featuredListings, latestListings } from "@/lib/search/service";
import type { SearchCard } from "@/lib/search/types";
import { mediaBaseUrl } from "@/lib/storage/keys";

const favoriteAction = (card: SearchCard) => <FavoriteButton listingId={card.id} />;
const rowFavorite = (listing: MapListing) => <FavoriteButton listingId={listing.id} />;

// Home (design D21), the living map (Carte vivante, lot 3): when a basemap is configured and the
// browser can draw it, a full-bleed map of Morocco carries the newest listings and À la Une as pins
// (the search page's map, shared), and the page's content floats beside it (desktop: a panel at the
// start side; phones: a sheet opened half way): the promise, the twelve categories in one rail,
// the À la Une and recent rows, the car rental entry, the three pillars and the legal links. "Voir
// toutes les annonces" and "Rechercher dans cette zone" open the search page.
// The list view (Save-Data or 2G, no WebGL2, no basemap, or the visitor's choice) is the classic
// page: the arcade of categories, the rental module, À la Une, the 12 newest, the pillars, the ad
// slot and the full footer. The server renders the panel first (meaningful without script); the map
// island loads after hydration. All of it behind the welcome threshold of a first visit (C7). ISR
// every 5 minutes; an engine failure hides the two listing sections (D2) and the page still renders.

export const revalidate = 300;
// Rendered on the first visit, never at build: the image is built without a search engine, so a
// build-time page has no listing sections, and after each deploy the purged edge would cache it
// (served stale by the origin, then re-stamped for 5 minutes). Hence no locale here, and none in the
// (public) layout either: a parent's params would be prerendered whatever this list says
// (localeParams, src/i18n/params.ts); scripts/check-prerender.ts fails the build otherwise.
// The basemap is read at that render too (runtime config, one image for staging and production).
export const dynamicParams = true;

export function generateStaticParams(): { locale: string }[] {
  return [];
}

/** Newest listings loaded: the map's pins and rows (one cached engine call per ISR render). */
const HOME_RECENT_COUNT = 24;
/** "Annonces récentes" grid of the list view. */
const HOME_GRID_COUNT = 12;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternates(pageLocale(locale)) };
}

/** Cards of a section, or null when the engine failed (the section is then left out). */
async function section(name: string, load: () => Promise<SearchCard[]>): Promise<SearchCard[] | null> {
  try {
    return await load();
  } catch (error) {
    logger.warn({ section: name, err: (error as Error).message }, "home: search section unavailable");
    return null;
  }
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const map = searchMapConfig();
  const [t, own, welcome, flags, featured, recent, labels, legal, messages] = await Promise.all([
    getTranslations({ locale, namespace: "Home" }),
    getTranslations({ locale, namespace: "SearchMap" }),
    welcomeTexts(locale),
    getFlags(),
    section("featured", () => featuredListings({}, FEATURED_HOME_SLOTS)),
    section("recent", () => latestListings({}, HOME_RECENT_COUNT)),
    mapListingLabels(locale),
    getLegalConfig(),
    getMessages({ locale }),
  ]);
  const serverView = map ? "map" : "list";
  // A listing drawn for À la Une shows once on the map, as its gold arch.
  const listings = map ? buildMapListings({ featured: featured ?? [], hits: withoutFeatured(recent ?? [], featured ?? []), locale, media: mediaBaseUrl(), now: new Date(), labels }) : [];
  const cards = new Map([...(recent ?? []), ...(featured ?? [])].map((card) => [card.id, card]));
  const featuredRows = listings.filter((listing) => listing.featured);
  const recentRows = listings.filter((listing) => !listing.featured);
  // The map's switch, sheet, pins and detail panel read the SearchMap namespace (a nested provider replaces, never merges).
  const clientMessages = pickMessages(messages, [...PUBLIC_CLIENT_NAMESPACES, ...HOME_PAGE_CLIENT_NAMESPACES]);

  return (
    <>
      {/* First visit only (decided before paint, see src/lib/welcome/script.ts); hidden otherwise. */}
      <WelcomeThreshold locale={locale} texts={welcome} />
      <NextIntlClientProvider locale={locale} messages={clientMessages}>
        <SearchNavigationProvider>
          <SearchMapRoot variant="home" startSnap="half" serverView={serverView} map={map} listings={listings} params={{}} className="flex flex-1 flex-col">
            <Container className="search-flow pt-4 sm:pt-8">
              <section id="search-panel" aria-labelledby="home-title" data-testid="home-panel" className="search-panel home-panel flex flex-col">
                <SheetHandle />
                <header className="search-panel-head home-panel-head flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <h1 id="home-title" className="max-w-2xl text-2xl font-semibold text-balance sm:text-3xl">
                      {t("title")}
                    </h1>
                    <p className="mt-2 max-w-xl text-foreground-muted text-pretty sm:text-lg">{t("subtitle")}</p>
                  </div>
                  <ViewToggle className="home-view-toggle self-start" />
                </header>
                <MapFailedNotice />

                {/* Map view (and its no-script page): the panel's content. */}
                {map ? (
                  <RowsArea className="search-rows home-rows flex flex-col gap-6">
                    <RentShortcuts />
                    <CategoryGrid variant="rail" />
                    {featuredRows.length > 0 ? (
                      <section aria-labelledby="home-featured-rows" data-testid="home-featured-rows" className="flex flex-col gap-1">
                        <FeaturedHeading id="home-featured-rows" className="px-2" />
                        <ResultRows listings={featuredRows} cards={cards} renderAction={rowFavorite} priorityCount={2} label={own("featuredRows")} />
                      </section>
                    ) : null}
                    {recentRows.length > 0 ? (
                      <section aria-labelledby="home-recent-rows" data-testid="home-recent-rows" className="flex flex-col gap-1">
                        <h2 id="home-recent-rows" className="px-2 text-base font-semibold sm:text-lg">
                          {t("recent.title")}
                        </h2>
                        <ResultRows listings={recentRows} cards={cards} renderAction={rowFavorite} priorityCount={featuredRows.length > 0 ? 0 : 2} label={t("recent.title")} />
                      </section>
                    ) : null}
                    <Button asChild variant="outline" className="mx-2">
                      <Link href={SEARCH_PATH}>{t("recent.all")}</Link>
                    </Button>
                    <RentCarLink className="mx-2" />
                    <HomePillars compact className="px-2 pb-2" />
                  </RowsArea>
                ) : null}

                {/* List view: the classic home page, its ad slot included (rendered only there: no hidden ad). */}
                <ListViewOnly serverView={serverView}>
                  <div className="flex flex-col gap-12 py-10 sm:gap-14 sm:py-14">
                    {/* Desktop only (AF §8 table): no ad on the phone home page. */}
                    <AdSlot placement="home-leaderboard" eligible promos={availablePromos(flags)} seed="home" />
                    <CategoryGrid />
                    <RentCarModule locale={locale} />
                    {featured && featured.length > 0 ? <FeaturedCarousel cards={featured} locale={locale} renderAction={favoriteAction} /> : null}
                    {recent && recent.length > 0 ? (
                      <section aria-labelledby="home-recent" data-testid="home-recent" className="flex flex-col gap-5">
                        <h2 id="home-recent" className="text-xl font-semibold">
                          {t("recent.title")}
                        </h2>
                        <ResultsGrid cards={recent.slice(0, HOME_GRID_COUNT)} locale={locale} renderAction={favoriteAction} />
                        <Button asChild variant="outline" className="self-center">
                          <Link href={SEARCH_PATH}>{t("recent.all")}</Link>
                        </Button>
                      </section>
                    ) : null}
                    <HomePillars />
                  </div>
                </ListViewOnly>
                <PanelLegal publisher={legal.companyName} className="search-panel-legal" />
              </section>
            </Container>
            <PanelHandle />
            <MapStage />
            <DetailPanel />
          </SearchMapRoot>
        </SearchNavigationProvider>
      </NextIntlClientProvider>
    </>
  );
}
