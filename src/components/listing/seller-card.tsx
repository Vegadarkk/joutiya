import type { ReactNode } from "react";
import { BadgeCheck, MailCheck, MapPin, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { intlLocale } from "@/lib/listings/client/format";
import type { PublicSeller } from "@/lib/listings/public";
import { cn } from "@/lib/utils";

// The seller block of the listing page (art. 6(3) DSA: who offers the item is always shown) and the
// header of the public profile: door-shaped initial (the brand's arch over a gold threshold), name,
// seniority, verified badges, listings online. No contact data: the number only comes from the
// reveal API, the contact actions are passed in as children. The profile links never prefetch: a
// prefetch counts against the page-view limits like a visit (/profil is metered, D14).

/** "2025-10" -> "octobre 2025" / "أكتوبر 2025". */
export function formatMemberSince(yearMonth: string, locale: Locale): string {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month) return yearMonth;
  return new Intl.DateTimeFormat(intlLocale(locale), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** First letter of the display name (any script), upper-cased. */
export function initialOf(name: string): string {
  const letter = [...name.trim()][0] ?? "?";
  return letter.toLocaleUpperCase();
}

export function SellerAvatar({ name, size = "md", className }: { name: string; size?: "md" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "threshold flex shrink-0 items-center justify-center rounded-arch bg-structure pt-1 font-semibold text-structure-foreground",
        size === "lg" ? "h-20 w-16 text-3xl" : "h-14 w-11 text-xl",
        className,
      )}
    >
      {initialOf(name)}
    </span>
  );
}

export function SellerBadges({ badges, sellerType, className }: Pick<PublicSeller, "badges" | "sellerType"> & { className?: string }) {
  const t = useTranslations("ListingPage.seller");
  const items: { key: string; icon: typeof ShieldCheck; label: string }[] = [];
  if (sellerType === "pro" && badges.proCertified) items.push({ key: "pro", icon: BadgeCheck, label: t("proCertified") });
  if (badges.phoneVerified) items.push({ key: "phone", icon: ShieldCheck, label: t("phoneVerified") });
  if (badges.emailVerified) items.push({ key: "email", icon: MailCheck, label: t("emailVerified") });
  if (items.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", className)}>
      {items.map(({ key, icon: Icon, label }) => (
        <li key={key} className="inline-flex items-center gap-1.5 rounded-sm bg-success-surface px-2 py-1 text-xs font-medium text-success">
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

export interface SellerCardProps {
  /** Null when the account has no public face any more: the denormalized name is shown alone. */
  seller: PublicSeller | null;
  /** `listing.sellerName`, shown when `seller` is null. */
  fallbackName: string;
  fallbackType: PublicSeller["sellerType"];
  locale: Locale;
  /** Contact actions (the client island), under the identity. */
  children?: ReactNode;
  className?: string;
}

export function SellerCard({ seller, fallbackName, fallbackType, locale, children, className }: SellerCardProps) {
  const t = useTranslations("ListingPage.seller");
  const name = seller?.displayName ?? fallbackName;
  const type = seller?.sellerType ?? fallbackType;
  const city = seller?.citySlug ? cityBySlug(seller.citySlug) : undefined;

  return (
    <section data-testid="seller-card" aria-labelledby="seller-name" className={cn("flex flex-col gap-5 rounded-lg border border-border bg-surface p-5", className)}>
      <div className="flex items-start gap-4">
        <SellerAvatar name={name} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-xs text-foreground-muted">{type === "pro" ? t("roleBusiness") : t("roleIndividual")}</p>
          <h2 id="seller-name" className="flex flex-wrap items-center gap-2 text-lg font-semibold leading-tight">
            {seller ? (
              <Link href={`/profil/${seller.publicId}`} prefetch={false} className="break-words rounded-sm hover:underline hover:underline-offset-2">
                {name}
              </Link>
            ) : (
              <span className="break-words">{name}</span>
            )}
            {type === "pro" ? <span className="rounded-sm bg-structure px-2 py-0.5 text-xs font-medium text-structure-foreground">{t("pro")}</span> : null}
          </h2>
          {seller ? <p className="text-sm text-foreground-muted">{t("memberSince", { date: formatMemberSince(seller.memberSince, locale) })}</p> : null}
          {city ? (
            <p className="flex items-center gap-1 text-sm text-foreground-muted">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              {cityName(city, locale)}
            </p>
          ) : null}
        </div>
      </div>
      {seller ? <SellerBadges badges={seller.badges} sellerType={seller.sellerType} /> : null}
      {seller ? (
        <Link href={`/profil/${seller.publicId}`} prefetch={false} className="-my-3 inline-flex min-h-11 items-center self-start rounded-sm text-sm font-medium text-link underline underline-offset-4 hover:no-underline">
          {t("listingsOnline", { count: seller.publishedCount })}
        </Link>
      ) : null}
      {children}
    </section>
  );
}
