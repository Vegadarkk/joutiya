import { Fragment, cache } from "react";
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
import { RentalFleet, type FleetLabels } from "@/components/rental/rental-fleet";
import { RentalAgencyCard, RentalBranches, RentalConditions } from "@/components/rental/rental-storefront";
import { SellerInfo } from "@/components/pro/seller-info";
import { StorefrontTabs } from "@/components/storefront/storefront-tabs";
import { ReportButton } from "@/components/report/report-button";
import { RatingLink } from "@/components/reviews/rating-link";
import { SellerReviews } from "@/components/reviews/seller-reviews";
import { Button } from "@/components/ui/button";
import { ExampleBanner } from "@/components/listing/example-banner";
import { RENTAL_SUBCATEGORY, criterionById } from "@/config/categories";
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
import { rentalFleet } from "@/lib/search/rental-fleet";
import type { RentalFleetView } from "@/lib/search/rental-fleet-view";
import { searchPath } from "@/lib/search/params";
import { shopShelves, shopSubcategoryCounts } from "@/lib/search/storefront";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Storefront of a verified Pro shop (phase 7 design §4): /boutique/{slug}-{proId}. ISR like the
// profile page; a shop whose storefront is not shown (pending, rejected, downgraded, suspended)
// or an unknown one is a 404, an outdated slug redirects to the current one. The listings are the
// owner's published ones; a change reaches the page within `revalidate` (the listing page itself
// is revalidated at once). A real-estate agency's storefront (Agence pack design §3) adds its
// listings per transaction and its fee schedule; a car rental agency's (rental pack §5) leads with
// its fleet by category, filtered by dates in place, then its card, conditions and branches.

export const revalidate = 300;
export const dynamicParams = true;

/** Cards shown; the count above the grid stays exact beyond it. */
const STOREFRONT_LISTINGS = 24;

export function generateStaticParams(): { shop: string }[] {
  return [];
}

type Params = Promise<{ locale: string; shop: string }>;

/** Option labels of a criterion, in its order. */
function optionLabels(criterionId: string, label: (key: string) => string): { id: string; label: string }[] {
  const criterion = criterionById(criterionId);
  const options = criterion && "options" in criterion ? (criterion.options as readonly string[]) : [];
  return options.map((id) => ({ id, label: label(`${criterionId}.options.${id}`) }));
}

/** The fleet's criterion labels, translated here: the storefront ships no criteria catalog. */
function fleetLabels(fleet: RentalFleetView, label: (key: string) => string): FleetLabels {
  const classes = new Set(fleet.vehicles.map((vehicle) => vehicle.rentalClass));
  return {
    classes: optionLabels("rental-class", label).filter((option) => classes.has(option.id)),
    gearbox: Object.fromEntries(optionLabels("gearbox", label).map((option) => [option.id, option.label])),
    fuel: Object.fromEntries(optionLabels("fuel", label).map((option) => [option.id, option.label])),
  };
}

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
    // An empty shop has nothing to show search engines yet; an example shop is not a business.
    ...(store.seller.publishedCount > 0 && !store.example ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function StorefrontPage({ params }: { params: Params }) {
  const { locale: value, shop } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const store = await load(shop);
  if (!store) notFound();
  if (store.segment !== shop) permanentRedirect(storefrontPath(locale, store.segment));

  const rentalAgency = store.sector === "car_rental";
  const [t, profile, criteria, legal, flags, vehicles, fleet, shelves] = await Promise.all([
    getTranslations({ locale: numbersLocale(locale), namespace: "Storefront" }),
    getTranslations({ locale: numbersLocale(locale), namespace: "Profile" }),
    getTranslations({ locale, namespace: "Criteria" }),
    getLegalConfig(),
    getFlags(),
    // A car dealer's stock at a glance (Concession pack); null for a shop without vehicles.
    store.seller.publishedCount > 0 ? dealerStock(store.seller.publicId) : null,
    // A car rental agency's fleet (rental pack §5); null when it rents nothing yet.
    rentalAgency && store.seller.publishedCount > 0 ? rentalFleet(store.seller.publicId) : null,
    // Its sections and running promotions (catalogue §5), as tabs over the grid.
    store.seller.publishedCount > 0 && !store.example ? shopShelves(store.seller.publicId, store.sections) : [],
  ]);
  const media = mediaBaseUrl();
  const city = cityBySlug(store.citySlug);
  const { seller } = store;
  // A rental agency's rentals are in its fleet: the grid holds its other listings.
  const listings = fleet ? seller.listings.filter((listing) => listing.subcategoryId !== RENTAL_SUBCATEGORY) : seller.listings;
  const listedCount = fleet ? Math.max(0, seller.publishedCount - fleet.total) : seller.publishedCount;
  const hidden = listedCount - listings.length;
  const initial = Array.from(store.name.trim())[0]?.toLocaleUpperCase() ?? "?";
  const agency = store.sector === "real_estate";
  const holidayAgency = store.sector === "holiday_rental";
  const counts = agency && seller.publishedCount > 0 ? await shopSubcategoryCounts(seller.publicId, "immobilier") : null;
  const label = agency ? t("agency.label") : rentalAgency ? t("rental.label") : holidayAgency ? t("holiday.label") : t("label");
  const aside = (
    <p className="rounded-md bg-surface-muted p-4 text-sm text-foreground-muted text-pretty">
      {store.example ? t("example.note") : agency ? t("agency.verifiedNote") : rentalAgency ? t("rental.verifiedNote") : holidayAgency ? t("holiday.verifiedNote") : t("verifiedNote")}
    </p>
  );

  const allListings = (
    <>
      {listings.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4">
          {listings.map((listing) => (
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
      {hidden > 0 ? <p className="text-sm text-foreground-muted">{profile("newest", { shown: listings.length })}</p> : null}
    </>
  );

  return (
    <Container className="flex flex-col gap-10 py-8 lg:gap-12 lg:py-12">
      {/* The shop's door: the Pro green under the arch, its gold threshold, the monogram where a logo will go. */}
      <header data-testid="storefront-header" className="arch threshold flex flex-col items-center gap-5 rounded-b-lg bg-structure px-6 pt-12 pb-9 text-center text-structure-foreground sm:flex-row sm:items-end sm:gap-7 sm:px-10 sm:text-start">
        <span aria-hidden="true" className="flex size-20 shrink-0 items-center justify-center rounded-full bg-featured text-3xl font-semibold text-featured-foreground shadow-sm">
          {initial}
        </span>
        <div className="flex min-w-0 flex-col items-center gap-2 sm:items-start">
          <p className="text-sm text-structure-foreground/80">{label}</p>
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
          {store.example ? null : <BadgeCheck className="size-4" aria-hidden="true" />}
          {store.example ? t("example.badge") : agency || rentalAgency || holidayAgency ? t("agency.verified") : t("verified")}
        </span>
      </header>
      {store.example ? <ExampleBanner scope="shop" /> : null}

      {counts ? <AgencyTransactions counts={counts} shopPublicId={seller.publicId} /> : null}
      {fleet ? <RentalFleet fleet={fleet} labels={fleetLabels(fleet, (key) => criteria(key as Parameters<typeof criteria>[0]))} shopPublicId={seller.publicId} mediaBaseUrl={media} locale={locale} /> : null}

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
          {store.rental ? <RentalAgencyCard rental={store.rental} checkedAt={store.rentalCheckedAt} locale={locale} /> : null}
          <FeeSchedule text={store.feeSchedule} />
          {store.payment ? <PayAtSeller payment={store.payment} className="rounded-lg border border-border bg-surface p-4" /> : null}
          {aside}
        </div>
      </div>

      {fleet ? <RentalConditions conditions={fleet.conditions} locale={locale} /> : null}
      {store.rental ? <RentalBranches rental={store.rental} locale={locale} /> : null}

      {vehicles ? <DealerStock stock={vehicles} shop={seller.publicId} /> : null}

      {fleet && listings.length === 0 ? null : (
        <section aria-labelledby="storefront-listings" className="flex flex-col gap-6">
          <h2 id="storefront-listings" className="text-xl font-semibold">
            {fleet ? t("rental.otherListings", { count: listedCount }) : profile("listingsTitle", { count: seller.publishedCount })}
          </h2>
          {shelves.length > 0 ? (
            <StorefrontTabs
              label={t("shelves.label")}
              tabs={[
                { key: "all", label: t("shelves.all"), count: listedCount },
                ...shelves.map((shelf) => ({ key: shelf.key, label: shelf.kind === "promo" ? t("shelves.promotions") : shelf.name, count: shelf.total, promo: shelf.kind === "promo" })),
              ]}
              panels={[
                allListings,
                ...shelves.map((shelf) => (
                  <Fragment key={shelf.key}>
                    <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4">
                      {shelf.listings.map((listing) => (
                        <li key={listing.id} className="min-w-0">
                          <ListingCard listing={listing} mediaBaseUrl={media} locale={locale} action={<FavoriteButton listingId={listing.id} />} />
                        </li>
                      ))}
                    </ul>
                    {shelf.total > shelf.listings.length ? (
                      <Button asChild variant="outline" className="self-start">
                        <Link href={searchPath(shelf.params)}>{t("shelves.seeAll", { count: shelf.total })}</Link>
                      </Button>
                    ) : null}
                  </Fragment>
                )),
              ]}
            />
          ) : (
            allListings
          )}
        </section>
      )}

{store.payment ? <SellerInfo payment={store.payment} /> : null}

      <SellerReviews
        rating={seller.rating}
        page={seller.reviews}
        publicId={seller.publicId}
        sellerName={store.name}
        locale={locale}
        report={{ email: legal.dsaContactEmail, url: `${CANONICAL_ORIGIN}${storefrontPath(locale, store.segment)}#avis` }}
      />

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
