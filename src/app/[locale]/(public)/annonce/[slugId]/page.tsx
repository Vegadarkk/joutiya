import { cache } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CalendarDays, MapPin, ShieldAlert } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Container } from "@/components/layout/container";
import { AdSlot } from "@/components/ads/ad-slot";
import { Breadcrumb, landingHref } from "@/components/listing/breadcrumb";
import { ContactBar } from "@/components/listing/contact-bar";
import { CriteriaSection } from "@/components/listing/criteria-grid";
import { Gallery } from "@/components/listing/gallery";
import { JsonLd } from "@/components/listing/json-ld";
import { ListingStatusBanner } from "@/components/listing/listing-status-banner";
import { PriceTag } from "@/components/listing/price-tag";
import { SafetyTips } from "@/components/listing/safety-tips";
import { SellerCard } from "@/components/listing/seller-card";
import { ListingMapBlock } from "@/components/map/listing-map-block";
import { ReportButton } from "@/components/report/report-button";
import { categoryById, subcategoryById } from "@/config/categories";
import { availablePromos } from "@/config/house-promos";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import { CANONICAL_ORIGIN, LOCALE_TAGS, type Locale } from "@/config/site";
import { pageLocale } from "@/i18n/params";
import { getFlags } from "@/lib/config/runtime";
import { isolate } from "@/lib/i18n/bidi";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { formatDate, formatPrice } from "@/lib/listings/client/format";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { listingJsonLd } from "@/lib/listings/jsonld";
import { getPublishedBySlugId, getSeller, listingPath, toPublicListing, type PublicListing, type PublicSeller } from "@/lib/listings/public";
import { logger } from "@/lib/logging/logger";
import { isIndexable } from "@/lib/search/document";
import { breadcrumbJsonLd } from "@/lib/seo/jsonld";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Public listing page (design D1, D10, D14, §5, §8): ISR, rendered on the first visit and kept 5
// minutes (lifecycle transitions revalidate it at once). No loading.tsx above it: notFound() and the
// slug redirect must answer before anything streams. Nothing per viewer in the HTML (shared by
// Cloudflare): the phone, the session and the owner view are client islands.

export const revalidate = 300;
export const dynamicParams = true;

export function generateStaticParams(): { slugId: string }[] {
  return [];
}

type Params = Promise<{ locale: string; slugId: string }>;

interface Loaded {
  listing: PublicListing;
  /** Server side only: the seller lookup. Never rendered, never passed to a client component. */
  ownerUid: string;
  redirect: boolean;
  /** In the search index (D9), so counted by its deeper category landing pages. */
  indexed: boolean;
  /** Ads may run on the page (phase 6, D6): published, no open report, an eligible subcategory. */
  adsEligible: boolean;
}

/** One Firestore read per render, shared by generateMetadata and the page. */
const load = cache(async (segment: string): Promise<Loaded | null> => {
  const found = await getPublishedBySlugId(segment);
  if (!found) return null;
  const listing = toPublicListing(found.listing, found.state, found.canonicalSlugId);
  if (!listing) return null;
  return {
    listing,
    ownerUid: found.listing.ownerUid,
    redirect: found.redirect,
    indexed: isIndexable(found.listing),
    adsEligible: found.state === "published" && found.listing.adsEligible === true,
  };
});

async function sellerOf(ownerUid: string): Promise<PublicSeller | null> {
  try {
    return await getSeller(ownerUid);
  } catch (error) {
    // The listing stays readable without its seller block (denormalized name shown instead).
    logger.warn({ err: (error as Error).message }, "listing page: seller lookup failed");
    return null;
  }
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, slugId } = await params;
  const locale = pageLocale(value);
  const found = await load(slugId);
  if (!found || found.redirect) return {};
  const { listing } = found;
  const [t, card] = await Promise.all([getTranslations({ locale, namespace: "ListingPage.meta" }), getTranslations({ locale, namespace: "ListingCard" })]);
  const city = cityBySlug(listing.location.citySlug);
  const title = city ? t("title", { title: listing.title, city: cityName(city, locale) }) : listing.title;
  const price = listing.isDonation ? card("donation") : listing.price === null ? card("toDiscuss") : formatPrice(listing.price, locale);
  // The price keeps its no-break spaces; only the seller's text is flattened.
  const description = `${price}. ${flatten(listing.description, 160 - price.length - 2)}`;
  const path = `/annonce/${listing.slugId}`;
  const cover = listing.photos[0];
  const coverUrl = cover ? photoUrl(mediaBaseUrl(), listing.id, cover.id, "l") : null;
  const images = cover && coverUrl ? [{ url: coverUrl, width: cover.w, height: cover.h, alt: listing.title }] : undefined;
  return {
    title,
    description,
    alternates: alternates(locale, path),
    openGraph: { type: "website", siteName: "Joutiya", locale: LOCALE_TAGS[locale].replace("-", "_"), url: `/${locale}${path}`, title, description, images },
    twitter: { card: images ? "summary_large_image" : "summary", title, description, images: images?.map((image) => image.url) },
    // Paused, sold and expired pages stay reachable for buyers who saved them, not for search engines.
    ...(listing.state === "published" ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ListingPage({ params }: { params: Params }) {
  const { locale: value, slugId } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const found = await load(slugId);
  if (!found) notFound();
  if (found.redirect) permanentRedirect(listingPath(locale, found.listing.slugId));

  const { listing } = found;
  const [seller, legal, flags, t, names] = await Promise.all([
    sellerOf(found.ownerUid),
    getLegalConfig(),
    getFlags(),
    getTranslations({ locale, namespace: "ListingPage" }),
    getTranslations({ locale, namespace: "Categories" }),
  ]);
  const media = mediaBaseUrl();
  const category = categoryById(listing.categoryId);
  const subcategory = subcategoryById(listing.subcategoryId);
  const city = cityBySlug(listing.location.citySlug);
  const region = regionByCode(listing.location.regionCode);
  type CategoryKey = Parameters<typeof names>[0];
  const categoryName = category ? names(`${category.id}.name` as CategoryKey) : undefined;
  const subcategoryName = category && subcategory?.categoryId === category.id ? names(`${category.id}.sub.${subcategory.id}` as CategoryKey) : undefined;
  const cityLabel = city ? cityName(city, locale) : undefined;
  const regionLabel = region ? regionName(region, locale) : undefined;
  // The district is the seller's text: isolated, so a Latin name keeps its place in Arabic (and the reverse).
  // The separator is the locale's ("، " in Arabic).
  const district = listing.location.district ? isolate(listing.location.district) : undefined;
  const place = cityLabel && district ? t("cityDistrict", { city: cityLabel, district }) : (cityLabel ?? district ?? "");
  const canonicalUrl = `${CANONICAL_ORIGIN}${listingPath(locale, listing.slugId)}`;
  const images = listing.photos.map((photo) => photoUrl(media, listing.id, photo.id, "l")).filter((url): url is string => url !== null);
  const published = listing.state === "published";

  const jsonLd = listingJsonLd({ listing, url: canonicalUrl, images, categoryName: subcategoryName ?? categoryName, cityName: cityLabel, regionName: regionLabel });
  // Crawlable steps: the category landing pages (/recherche is robots-disallowed). /c/{category}
  // always answers 200, a deeper page 404s without listings (D15): those are linked only while this
  // listing counts in them (indexed, so not paused, sold or expired), and with a known subcategory.
  const deep = found.indexed;
  const landingSubcategory = subcategoryName ? listing.subcategoryId : undefined;
  const trail = [
    ...(categoryName ? [{ label: categoryName, href: landingHref({ category: listing.categoryId }) }] : []),
    ...(deep && categoryName && subcategoryName ? [{ label: subcategoryName, href: landingHref({ category: listing.categoryId, subcategory: landingSubcategory }) }] : []),
    ...(deep && categoryName && cityLabel
      ? [{ label: cityLabel, href: landingHref({ category: listing.categoryId, subcategory: landingSubcategory, city: listing.location.citySlug }) }]
      : []),
  ];
  const breadcrumbLd = breadcrumbJsonLd([
    { name: t("home"), url: `${CANONICAL_ORIGIN}/${locale}` },
    ...trail.map((step) => ({ name: step.label, url: `${CANONICAL_ORIGIN}/${locale}${step.href}` })),
    { name: listing.title },
  ]);

  return (
    <>
      <JsonLd data={jsonLd} />
      {breadcrumbLd ? <JsonLd data={breadcrumbLd} /> : null}
      <Container className="flex flex-col gap-5 pt-3 pb-12 sm:pt-5 lg:pb-16">
        <Breadcrumb
          current={listing.title}
          items={[
            { label: t("home"), href: "/" },
            ...trail.map((step) => ({ label: step.label, href: step.href })),
          ]}
        />
        <ListingStatusBanner state={listing.state} />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-10 lg:[grid-template-areas:'gallery_aside'_'header_aside'_'body_aside'] xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="-mx-4 sm:mx-0 lg:[grid-area:gallery]">
            <Gallery listingId={listing.id} title={listing.title} photos={listing.photos} mediaBaseUrl={media} />
          </div>

          <header className="flex min-w-0 flex-col gap-3 lg:[grid-area:header]">
            <h1 dir="auto" className="text-2xl font-semibold text-balance break-words sm:text-3xl">
              {listing.title}
            </h1>
            <PriceTag price={listing.price} isDonation={listing.isDonation} negotiable={listing.priceNegotiable} unit={subcategory?.priceUnit} locale={locale} size="lg" />
            {subcategory?.adultsOnly ? (
              <p data-testid="adults-only-notice" className="flex items-start gap-2 self-start rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-sm text-foreground text-pretty">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  <strong className="font-semibold">{t("adultsOnly.title")}</strong> {t("adultsOnly.body")}
                </span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-foreground-muted">
              {place ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-4 shrink-0" aria-hidden="true" />
                  {regionLabel ? t("place", { place, region: regionLabel }) : place}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
                <time dateTime={listing.publishedAt}>{t("publishedOn", { date: formatDate(new Date(listing.publishedAt), locale) })}</time>
              </span>
            </div>
            {published ? <FavoriteButton listingId={listing.id} variant="inline" className="self-start" /> : null}
          </header>

          <aside aria-label={t("sellerLabel")} className="min-w-0 lg:[grid-area:aside]">
            <div className="flex flex-col gap-6 lg:sticky lg:top-24">
              <SellerCard seller={seller} fallbackName={listing.seller.name} fallbackType={listing.seller.type} locale={locale}>
                {published ? (
                  <ContactBar
                    listingId={listing.id}
                    slugId={listing.slugId}
                    sellerPublicId={listing.seller.publicId}
                    sellerName={listing.seller.name}
                    listingTitle={listing.title}
                    showPhone={listing.contact.showPhone}
                    whatsapp={listing.contact.whatsapp}
                    adultsOnly={Boolean(subcategory?.adultsOnly)}
                  />
                ) : null}
              </SellerCard>
            </div>
          </aside>

          <div className="flex min-w-0 flex-col gap-10 lg:[grid-area:body]">
            <CriteriaSection title={t("criteriaTitle")} subcategoryId={listing.subcategoryId} attributes={listing.attributes} condition={listing.condition} />

            <section aria-labelledby="description-title" className="flex flex-col gap-3">
              <h2 id="description-title" className="text-lg font-semibold">
                {t("descriptionTitle")}
              </h2>
              {/* Plain text: React escapes it; line breaks and spacing kept as the seller typed them. Each
                  paragraph takes the direction of its own first letter (French and Arabic may alternate). */}
              <div data-testid="listing-description" dir="auto" className="max-w-prose whitespace-pre-wrap break-words text-pretty [unicode-bidi:plaintext]">
                {listing.description}
              </div>
            </section>

            <section aria-labelledby="location-title" className="flex flex-col gap-3">
              <h2 id="location-title" className="text-lg font-semibold">
                {t("locationTitle")}
              </h2>
              <p className="text-sm text-foreground-muted">{t("locationHint")}</p>
              <ListingMapBlock citySlug={listing.location.citySlug} regionCode={listing.location.regionCode} seed={listing.id} locale={locale} className="w-full max-w-[35rem]" />
            </section>

            {/* Report link, then the safety tips: a non-interactive block always stands between the ad
                and the contact or report controls (D6). */}
            <ReportButton target={{ type: "listing", id: listing.id }} subject={listing.title} ownerPublicId={listing.seller.publicId} email={legal.dsaContactEmail} url={canonicalUrl} />
            <SafetyTips />
            <AdSlot placement="listing-bottom" eligible={found.adsEligible} promos={availablePromos(flags)} seed={listing.id} />
          </div>
        </div>
      </Container>
    </>
  );
}
