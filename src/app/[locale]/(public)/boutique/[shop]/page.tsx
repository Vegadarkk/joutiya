import { cache } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { BadgeCheck, CalendarDays, MapPin } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { EmptyState } from "@/components/feedback/empty-state";
import { Container } from "@/components/layout/container";
import { AdSlot } from "@/components/ads/ad-slot";
import { AgencyTransactions, FeeSchedule } from "@/components/listing/agency-storefront";
import { ListingCard } from "@/components/listing/listing-card";
import { PayAtSeller } from "@/components/listing/pay-at-seller";
import { formatMemberSince } from "@/components/listing/seller-card";
import { DealerStock } from "@/components/pro/dealer-stock";
import { SellerInfo } from "@/components/pro/seller-info";
import { ReportButton } from "@/components/report/report-button";
import { RatingLink } from "@/components/reviews/rating-link";
import { SellerReviews } from "@/components/reviews/seller-reviews";
import { Button } from "@/components/ui/button";
import { availablePromos } from "@/config/house-promos";
import { cityBySlug, cityName } from "@/config/regions";
import { CANONICAL_ORIGIN, LOCALE_TAGS, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { getFlags } from "@/lib/config/runtime";
import { isolate } from "@/lib/i18n/bidi";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { getPublicStorefront, parseStorefrontSegment, storefrontPath } from "@/lib/listings/public";
import { dealerStock } from "@/lib/search/dealer";
import { shopSubcategoryCounts } from "@/lib/search/storefront";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Storefront of a verified Pro shop (phase 7 design §4): /boutique/{slug}-{proId}. ISR like the
// profile page; a shop whose storefront is not shown (pending, rejected, downgraded, suspended)
// or an unknown one is a 404, an outdated slug redirects to the current one. The listings are the
// owner's published ones; a change reaches the page within `revalidate` (the listing page itself
// is revalidated at once). A real-estate agency's storefront (Agence pack design §3) adds its
// listings per transaction and its fee schedule.

export const revalidate = 300;
export const dynamicParams = true;

/** Cards shown; the count above the grid stays exact beyond it. */
const STOREFRONT_LISTINGS = 24;

export function generateStaticParams(): { shop: string }[] {
  return [];
}

type Params = Promise<{ locale: string; shop: string }>;

const load = cache(async (segment: string) => {
  const parsed = parseStorefrontSegment(segment);
  return parsed ? getPublicStorefront(parsed.proId, STOREFRONT_LISTINGS) : null;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, shop } = await params;
  const locale = pageLocale(value);
  const store = await load(shop);
  if (!store) return {};
  const t = await getTranslations({ locale: numbersLocale(locale), namespace: "Storefront.meta" });
  const city = cityBySlug(store.citySlug);
  const where = city ? cityName(city, locale) : "";
  const title = t("title", { name: store.name, city: where });
  const description = t("description", { name: store.name, city: where, count: store.seller.publishedCount });
  const path = `/boutique/${store.segment}`;
  return {
    title,
    description,
    alternates: alternates(locale, path),
    openGraph: { type: "website", siteName: "Joutiya", locale: LOCALE_TAGS[locale].replace("-", "_"), url: `/${locale}${path}`, title, description },
    // An empty shop has nothing to show search engines yet.
    ...(store.seller.publishedCount > 0 ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function StorefrontPage({ params }: { params: Params }) {
  const { locale: value, shop } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const store = await load(shop);
  if (!store) notFound();
  if (store.segment !== shop) permanentRedirect(storefrontPath(locale, store.segment));

  const [t, profile, legal, flags, vehicles] = await Promise.all([
    getTranslations({ locale: numbersLocale(locale), namespace: "Storefront" }),
    getTranslations({ locale: numbersLocale(locale), namespace: "Profile" }),
    getLegalConfig(),
    getFlags(),
    // A car dealer's stock at a glance (Concession pack); null for a shop without vehicles.
    store.seller.publishedCount > 0 ? dealerStock(store.seller.publicId) : null,
  ]);
  const media = mediaBaseUrl();
  const city = cityBySlug(store.citySlug);
  const { seller } = store;
  const hidden = seller.publishedCount - seller.listings.length;
  const initial = Array.from(store.name.trim())[0]?.toLocaleUpperCase() ?? "?";
  const agency = store.sector === "real_estate";
  const counts = agency && seller.publishedCount > 0 ? await shopSubcategoryCounts(seller.publicId, "immobilier") : null;
  const aside = (
    <p className="rounded-md bg-surface-muted p-4 text-sm text-foreground-muted text-pretty">{agency ? t("agency.verifiedNote") : t("verifiedNote")}</p>
  );

  return (
    <Container className="flex flex-col gap-10 py-8 lg:gap-12 lg:py-12">
      {/* The shop's door: the Pro green under the arch, its gold threshold, the monogram where a logo will go. */}
      <header data-testid="storefront-header" className="arch threshold flex flex-col items-center gap-5 rounded-b-lg bg-structure px-6 pt-12 pb-9 text-center text-structure-foreground sm:flex-row sm:items-end sm:gap-7 sm:px-10 sm:text-start">
        <span aria-hidden="true" className="flex size-20 shrink-0 items-center justify-center rounded-full bg-featured text-3xl font-semibold text-featured-foreground shadow-sm">
          {initial}
        </span>
        <div className="flex min-w-0 flex-col items-center gap-2 sm:items-start">
          <p className="text-sm text-structure-foreground/80">{agency ? t("agency.label") : t("label")}</p>
          <h1 dir="auto" className="text-3xl font-semibold text-balance break-words sm:text-4xl">
            {store.name}
          </h1>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-structure-foreground/85 sm:justify-start">
            {city ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-4 shrink-0" aria-hidden="true" />
                {cityName(city, locale)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
              {profile("memberSince", { date: formatMemberSince(seller.memberSince, locale) })}
            </span>
            <RatingLink rating={seller.rating} locale={locale} />
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-featured px-3 py-1 text-sm font-medium text-featured-foreground sm:ms-auto sm:self-start">
          <BadgeCheck className="size-4" aria-hidden="true" />
          {agency ? t("agency.verified") : t("verified")}
        </span>
      </header>

      {counts ? <AgencyTransactions counts={counts} shopPublicId={seller.publicId} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-10">
        {store.description ? (
          <section aria-labelledby="storefront-about" className="flex flex-col gap-3">
            <h2 id="storefront-about" className="text-xl font-semibold">
              {t("about")}
            </h2>
            <p dir="auto" className="max-w-prose leading-relaxed whitespace-pre-line text-pretty">
              {store.description}
            </p>
          </section>
        ) : null}
        <div className={store.description ? "flex flex-col gap-4 self-start" : "flex max-w-prose flex-col gap-4 lg:col-span-2"}>
          <FeeSchedule text={store.feeSchedule} />
          {store.payment ? <PayAtSeller payment={store.payment} className="rounded-lg border border-border bg-surface p-4" /> : null}
          {aside}
        </div>
      </div>

      {vehicles ? <DealerStock stock={vehicles} shop={seller.publicId} /> : null}

      <section aria-labelledby="storefront-listings" className="flex flex-col gap-6">
        <h2 id="storefront-listings" className="text-xl font-semibold">
          {profile("listingsTitle", { count: seller.publishedCount })}
        </h2>
        {seller.listings.length > 0 ? (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4">
            {seller.listings.map((listing) => (
              <li key={listing.id} className="min-w-0">
                <ListingCard listing={listing} mediaBaseUrl={media} locale={locale} action={<FavoriteButton listingId={listing.id} />} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={profile("emptyTitle")}
            action={
              <Button asChild variant="outline">
                <Link href="/recherche">{profile("browse")}</Link>
              </Button>
            }
          >
            {profile("emptyBody", { name: isolate(store.name) })}
          </EmptyState>
        )}
        {hidden > 0 ? <p className="text-sm text-foreground-muted">{profile("newest", { shown: seller.listings.length })}</p> : null}
      </section>

      {store.payment ? <SellerInfo payment={store.payment} /> : null}

      <SellerReviews rating={seller.rating} page={seller.reviews} publicId={seller.publicId} sellerName={store.name} locale={locale} />

      {/* Profiles stay out of the ad inventory (AF §8 table): house promotion only. */}
      <AdSlot placement="profile-bottom" eligible={false} promos={availablePromos(flags)} seed={store.segment} />
      <ReportButton
        target={{ type: "user", id: seller.publicId }}
        subject={store.name}
        ownerPublicId={seller.publicId}
        email={legal.dsaContactEmail}
        url={`${CANONICAL_ORIGIN}${storefrontPath(locale, store.segment)}`}
      />
    </Container>
  );
}
