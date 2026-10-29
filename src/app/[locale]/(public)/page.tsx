import type { Metadata } from "next";
import { HandCoins, MapPinned, ShieldCheck } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdSlot } from "@/components/ads/ad-slot";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { CategoryGrid } from "@/components/home/category-grid";
import { FeaturedCarousel } from "@/components/home/featured-carousel";
import { SearchPanel } from "@/components/home/search-panel";
import { RentCarModule } from "@/components/rental/rent-car-module";
import { Container } from "@/components/layout/container";
import { ResultsGrid } from "@/components/search/results-grid";
import { Button } from "@/components/ui/button";
import { WelcomeThreshold, welcomeTexts } from "@/components/welcome/welcome-threshold";
import { availablePromos } from "@/config/house-promos";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getFlags } from "@/lib/config/runtime";
import { alternates } from "@/lib/i18n/metadata";
import { logger } from "@/lib/logging/logger";
import { FEATURED_HOME_SLOTS } from "@/lib/search/featured";
import { SEARCH_PATH } from "@/lib/search/params";
import { featuredListings, latestListings } from "@/lib/search/service";
import type { SearchCard } from "@/lib/search/types";

const favoriteAction = (card: SearchCard) => <FavoriteButton listingId={card.id} />;

// Home (design D21): search hero, the twelve categories, À la Une (8 drawn) and the 12 newest
// listings, behind the welcome threshold of a first visit (design C7). ISR every 5 minutes; an
// engine failure hides the two listing sections (D2) and the page still renders.

export const revalidate = 300;
// Rendered on the first visit, never at build: the image is built without a search engine, so a
// build-time page has no listing sections, and after each deploy the purged edge would cache it
// (served stale by the origin, then re-stamped for 5 minutes). Overrides the locales of the layout.
export const dynamicParams = true;

export function generateStaticParams(): { locale: string }[] {
  return [];
}

/** "Annonces récentes" on the home page. */
const HOME_RECENT_COUNT = 12;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternates(pageLocale(locale)) };
}

const PILLARS = [
  { key: "free", icon: HandCoins },
  { key: "near", icon: MapPinned },
  { key: "safe", icon: ShieldCheck },
] as const;

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
  const [t, welcome, flags, featured, recent] = await Promise.all([
    getTranslations({ locale, namespace: "Home" }),
    welcomeTexts(locale),
    getFlags(),
    section("featured", () => featuredListings({}, FEATURED_HOME_SLOTS)),
    section("recent", () => latestListings({}, HOME_RECENT_COUNT)),
  ]);
  return (
    <>
      {/* First visit only (decided before paint, see src/lib/welcome/script.ts); hidden otherwise. */}
      <WelcomeThreshold locale={locale} texts={welcome} />
      <Container className="pt-6 sm:pt-10">
        <SearchPanel locale={locale} />
      </Container>
      <Container className="flex flex-col gap-12 py-10 sm:gap-14 sm:py-14">
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
            <ResultsGrid cards={recent} locale={locale} renderAction={favoriteAction} />
            <Button asChild variant="outline" className="self-center">
              <Link href={SEARCH_PATH}>{t("recent.all")}</Link>
            </Button>
          </section>
        ) : null}
        <ul className="grid gap-8 sm:grid-cols-3">
          {PILLARS.map(({ key, icon: Icon }) => (
            <li key={key} className="flex gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-semibold">{t(`pillars.${key}.title`)}</h2>
                <p className="mt-1 text-sm text-foreground-muted">{t(`pillars.${key}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </>
  );
}
