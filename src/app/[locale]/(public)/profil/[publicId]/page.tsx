import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, MapPin, Search } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { EmptyState } from "@/components/feedback/empty-state";
import { Container } from "@/components/layout/container";
import { AdSlot } from "@/components/ads/ad-slot";
import { ListingCard } from "@/components/listing/listing-card";
import { formatMemberSince, SellerAvatar, SellerBadges } from "@/components/listing/seller-card";
import { ListingShelf, type ShelfItem } from "@/components/profile/listing-shelf";
import { StorefrontBanner } from "@/components/profile/storefront-banner";
import { ReportButton } from "@/components/report/report-button";
import { RatingLink } from "@/components/reviews/rating-link";
import { SellerReviews } from "@/components/reviews/seller-reviews";
import { Button } from "@/components/ui/button";
import { subcategoryById } from "@/config/categories";
import { availablePromos } from "@/config/house-promos";
import { cityBySlug, cityName } from "@/config/regions";
import { CANONICAL_ORIGIN, LOCALE_TAGS, SITE_NAME, type Locale } from "@/config/site";
import { STOREFRONT_LISTINGS } from "@/config/storefront";
import { Link } from "@/i18n/navigation";
import { numbersLocale, pageLocale } from "@/i18n/params";
import { getFlags } from "@/lib/config/runtime";
import { isolate } from "@/lib/i18n/bidi";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { getPublicProfile, profilePath } from "@/lib/listings/public";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Public profile of a seller (§5: /profil/{publicId}, never a uid), their storefront (vitrine-avis
// §1): house banner, who they are, their "about" text and their listings online, sorted and
// filtered in the browser. ISR like the listing page (lifecycle transitions revalidate it); unknown,
// closed, banned or never-activated accounts are a 404 (no loading.tsx above: real status code).

export const revalidate = 300;
export const dynamicParams = true;

export function generateStaticParams(): { publicId: string }[] {
  return [];
}

type Params = Promise<{ locale: string; publicId: string }>;

const load = cache((publicId: string) => getPublicProfile(publicId, STOREFRONT_LISTINGS));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, publicId } = await params;
  const locale = pageLocale(value);
  const profile = await load(publicId);
  if (!profile) return {};
  const t = await getTranslations({ locale: numbersLocale(locale), namespace: "Profile.meta" });
  const title = t("title", { name: profile.displayName });
  const description = t("description", { name: profile.displayName, count: profile.publishedCount, date: formatMemberSince(profile.memberSince, locale) });
  const path = `/profil/${profile.publicId}`;
  return {
    title,
    description,
    alternates: alternates(locale, path),
    openGraph: { type: "profile", siteName: SITE_NAME, locale: LOCALE_TAGS[locale].replace("-", "_"), url: `/${locale}${path}`, title, description },
    // A private seller's name stays out of search engines (loi 09-08); a business with listings is listed.
    ...(profile.sellerType === "pro" && profile.publishedCount > 0 ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ProfilePage({ params }: { params: Params }) {
  const { locale: value, publicId } = await params;
  const locale: Locale = pageLocale(value);
  setRequestLocale(locale);
  const profile = await load(publicId);
  if (!profile) notFound();

  const [t, categories, legal, flags] = await Promise.all([
    getTranslations({ locale: numbersLocale(locale), namespace: "Profile" }),
    getTranslations({ locale, namespace: "Categories" }),
    getLegalConfig(),
    getFlags(),
  ]);
  const media = mediaBaseUrl();
  const city = profile.citySlug ? cityBySlug(profile.citySlug) : undefined;
  const hidden = profile.publishedCount - profile.listings.length;
  const items: ShelfItem[] = profile.listings.map((listing) => ({
    id: listing.id,
    price: listing.isDonation ? null : listing.price,
    sortAt: listing.sortAt,
    categoryId: (listing.subcategoryId ? subcategoryById(listing.subcategoryId)?.categoryId : undefined) ?? null,
    node: <ListingCard listing={listing} mediaBaseUrl={media} locale={locale} action={<FavoriteButton listingId={listing.id} />} />,
  }));
  const categoryIds = [...new Set(items.map((item) => item.categoryId).filter((id): id is string => id !== null))];
  const categoryNames = Object.fromEntries(categoryIds.map((id) => [id, categories(`${id}.name` as Parameters<typeof categories>[0])]));

  return (
    <Container className="flex flex-col gap-10 py-6 lg:gap-12 lg:py-10">
      <header data-testid="profile-header" className="flex flex-col">
        <div data-testid="storefront-banner" data-banner={profile.bannerKey} className="h-28 overflow-hidden rounded-lg sm:h-40 lg:h-48">
          <StorefrontBanner bannerKey={profile.bannerKey} id={profile.publicId} />
        </div>
        <div className="flex flex-col gap-5 px-1 sm:flex-row sm:items-start sm:gap-6 sm:px-6">
          <SellerAvatar name={profile.displayName} size="xl" className="-mt-12 outline-4 outline-background sm:-mt-14" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:pt-4">
            <p className="text-sm text-foreground-muted">{profile.sellerType === "pro" ? t("roleBusiness") : t("roleIndividual")}</p>
            <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold text-balance break-words">
              <span dir="auto" className="min-w-0">
                {profile.displayName}
              </span>
              {profile.sellerType === "pro" ? <span className="rounded-sm bg-structure px-2 py-0.5 text-sm font-medium text-structure-foreground">{t("pro")}</span> : null}
            </h1>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-foreground-muted">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
                {t("memberSince", { date: formatMemberSince(profile.memberSince, locale) })}
              </span>
              {city ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-4 shrink-0" aria-hidden="true" />
                  {cityName(city, locale)}
                </span>
              ) : null}
              <RatingLink rating={profile.rating} locale={locale} />
            </div>
            <SellerBadges badges={profile.badges} sellerType={profile.sellerType} className="mt-1" />
          </div>
        </div>
      </header>

      {profile.bio ? (
        <section aria-labelledby="profile-about" className="flex max-w-prose flex-col gap-3 border-s-2 border-featured ps-5">
          <h2 id="profile-about" className="text-lg font-semibold">
            {t("about")}
          </h2>
          <p dir="auto" className="whitespace-pre-line text-pretty">
            {profile.bio}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="profile-listings" className="flex flex-col gap-6">
        <h2 id="profile-listings" className="text-xl font-semibold">
          {t("listingsTitle", { count: profile.publishedCount })}
        </h2>
        {items.length > 0 ? (
          <ListingShelf
            items={items}
            labels={{
              sort: t("shelf.sort"),
              sorts: { recent: t("shelf.recent"), priceAsc: t("shelf.priceAsc"), priceDesc: t("shelf.priceDesc") },
              filter: t("shelf.filter"),
              all: t("shelf.all"),
              categories: categoryNames,
            }}
          />
        ) : (
          <EmptyState
            title={t("emptyTitle")}
            action={
              <Button asChild variant="outline">
                <Link href="/recherche">{t("browse")}</Link>
              </Button>
            }
          >
            {t("emptyBody", { name: isolate(profile.displayName) })}
          </EmptyState>
        )}
        {hidden > 0 ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-foreground-muted">{t("newest", { shown: profile.listings.length })}</p>
            <Button asChild variant="outline">
              <Link href={`/recherche?vendeur-id=${profile.publicId}`} prefetch={false}>
                <Search aria-hidden="true" />
                {t("seeAll")}
              </Link>
            </Button>
          </div>
        ) : null}
      </section>

      <SellerReviews
        rating={profile.rating}
        page={profile.reviews}
        publicId={profile.publicId}
        sellerName={profile.displayName}
        locale={locale}
        report={{ email: legal.dsaContactEmail, url: `${CANONICAL_ORIGIN}${profilePath(locale, profile.publicId)}#avis` }}
      />

      {/* Profiles stay out of the ad inventory (AF §8 table): house promotion only. */}
      <AdSlot placement="profile-bottom" eligible={false} promos={availablePromos(flags)} seed={publicId} />
      <ReportButton
        target={{ type: "user", id: profile.publicId }}
        subject={profile.displayName}
        ownerPublicId={profile.publicId}
        email={legal.dsaContactEmail}
        url={`${CANONICAL_ORIGIN}${profilePath(locale, profile.publicId)}`}
      />
    </Container>
  );
}
