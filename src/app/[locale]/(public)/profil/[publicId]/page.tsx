import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, MapPin } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { EmptyState } from "@/components/feedback/empty-state";
import { Container } from "@/components/layout/container";
import { AdSlot } from "@/components/listing/ad-slot";
import { ListingCard } from "@/components/listing/listing-card";
import { ReportLink } from "@/components/listing/report-link";
import { formatMemberSince, SellerAvatar, SellerBadges } from "@/components/listing/seller-card";
import { Button } from "@/components/ui/button";
import { cityBySlug, cityName } from "@/config/regions";
import { CANONICAL_ORIGIN, LOCALE_TAGS, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { isolate } from "@/lib/i18n/bidi";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { getPublicProfile, profilePath } from "@/lib/listings/public";
import { mediaBaseUrl } from "@/lib/storage/keys";

// Public profile of a seller (§5: /profil/{publicId}, never a uid): who they are on Joutiya and
// their listings online. ISR like the listing page (lifecycle transitions revalidate it); unknown,
// closed, banned or never-activated accounts are a 404 (no loading.tsx above: real status code).

export const revalidate = 300;
export const dynamicParams = true;

/** Cards shown; the count above the grid stays exact beyond it. */
const PROFILE_LISTINGS = 24;

export function generateStaticParams(): { publicId: string }[] {
  return [];
}

type Params = Promise<{ locale: string; publicId: string }>;

const load = cache((publicId: string) => getPublicProfile(publicId, PROFILE_LISTINGS));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: value, publicId } = await params;
  const locale = pageLocale(value);
  const profile = await load(publicId);
  if (!profile) return {};
  const t = await getTranslations({ locale, namespace: "Profile.meta" });
  const title = t("title", { name: profile.displayName });
  const description = t("description", { name: profile.displayName, count: profile.publishedCount, date: formatMemberSince(profile.memberSince, locale) });
  const path = `/profil/${profile.publicId}`;
  return {
    title,
    description,
    alternates: alternates(locale, path),
    openGraph: { type: "profile", siteName: "Joutiya", locale: LOCALE_TAGS[locale].replace("-", "_"), url: `/${locale}${path}`, title, description },
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

  const [t, legal] = await Promise.all([getTranslations({ locale, namespace: "Profile" }), getLegalConfig()]);
  const media = mediaBaseUrl();
  const city = profile.citySlug ? cityBySlug(profile.citySlug) : undefined;
  const hidden = profile.publishedCount - profile.listings.length;

  return (
    <Container className="flex flex-col gap-10 py-8 lg:gap-12 lg:py-12">
      <header data-testid="profile-header" className="flex flex-col gap-5 border-b border-border pb-8 sm:flex-row sm:items-start sm:gap-6">
        <SellerAvatar name={profile.displayName} size="lg" />
        <div className="flex min-w-0 flex-col gap-2">
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
          </div>
          <SellerBadges badges={profile.badges} sellerType={profile.sellerType} className="mt-1" />
        </div>
      </header>

      <section aria-labelledby="profile-listings" className="flex flex-col gap-6">
        <h2 id="profile-listings" className="text-xl font-semibold">
          {t("listingsTitle", { count: profile.publishedCount })}
        </h2>
        {profile.listings.length > 0 ? (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4">
            {profile.listings.map((listing) => (
              <li key={listing.id} className="min-w-0">
                <ListingCard listing={listing} mediaBaseUrl={media} locale={locale} />
              </li>
            ))}
          </ul>
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
        {hidden > 0 ? <p className="text-sm text-foreground-muted">{t("newest", { shown: profile.listings.length })}</p> : null}
      </section>

      <AdSlot slot="profile-bottom" />
      <ReportLink email={legal.dsaContactEmail} target="profile" id={profile.publicId} url={`${CANONICAL_ORIGIN}${profilePath(locale, profile.publicId)}`} />
    </Container>
  );
}
