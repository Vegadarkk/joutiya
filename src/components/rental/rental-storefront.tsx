import { Banknote, BadgeInfo, Clock, IdCard, KeyRound, MapPin, Plane, ShieldCheck, Wallet, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { airportById } from "@/config/airports";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { formatPrice } from "@/lib/listings/client/format";
import type { RentalAgency } from "@/lib/pro/profile-schema";
import type { FleetConditions } from "@/lib/search/rental-fleet-view";
import { cn } from "@/lib/utils";

// Blocks of a car rental agency's storefront (rental pack §5), server-rendered: the agency card
// (licence reference « déclarée par l'agence », hours, payments on site, airports), its branches
// (declared professional addresses) and its conditions summed up from its listings. Everything is
// the agency's declaration; the written rental contract prevails.

const list = (items: string[], locale: Locale) => items.join(locale === "ar" ? "، " : ", ");

export function RentalAgencyCard({ rental, locale, className }: { rental: RentalAgency; locale: Locale; className?: string }) {
  const t = useTranslations("Storefront.rental");
  const r = useTranslations("Rental");
  const airports = rental.airports
    .map((id) => airportById(id))
    .filter((airport) => airport !== undefined)
    .map((airport) => {
      const city = cityBySlug(airport.citySlug);
      return r("airport", { city: city ? cityName(city, locale) : airport.citySlug, code: airport.id.toUpperCase() });
    });
  return (
    <section aria-labelledby="rental-agency" data-testid="rental-agency" className={cn("flex flex-col gap-4 rounded-lg border border-border bg-surface p-5", className)}>
      <h2 id="rental-agency" className="sr-only">
        {t("agencyTitle")}
      </h2>
      <div className="flex items-start gap-3">
        <Badge icon={IdCard} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium">
            {t("agrement")}{" "}
            <span dir="ltr" data-testid="rental-agrement" className="tabular-nums">
              {rental.agrementRef}
            </span>
          </p>
          <p className="text-sm text-foreground-muted text-pretty">{t("agrementDeclared")}</p>
        </div>
      </div>
      {rental.hours ? (
        <Row icon={Clock} title={t("hours")}>
          <span dir="auto" className="whitespace-pre-line">
            {rental.hours}
          </span>
        </Row>
      ) : null}
      {rental.payments.length > 0 ? (
        <Row icon={Banknote} title={t("payments")}>
          {list(
            rental.payments.map((payment) => t(`paymentOptions.${payment}`)),
            locale,
          )}
        </Row>
      ) : null}
      {airports.length > 0 ? (
        <Row icon={Plane} title={t("airports")}>
          {list(airports, locale)}
        </Row>
      ) : null}
    </section>
  );
}

export function RentalBranches({ rental, locale, className }: { rental: RentalAgency; locale: Locale; className?: string }) {
  const t = useTranslations("Storefront.rental");
  if (rental.branches.length === 0) return null;
  return (
    <section aria-labelledby="rental-branches" data-testid="rental-branches" className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-1">
        <h2 id="rental-branches" className="text-xl font-semibold">
          {t("branchesTitle")}
        </h2>
        <p className="text-sm text-foreground-muted">{t("branchesNote")}</p>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rental.branches.map((branch) => {
          const city = cityBySlug(branch.citySlug);
          return (
            <li key={`${branch.citySlug}-${branch.address}`} data-testid="rental-branch-card" className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
              <Badge icon={MapPin} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-medium">{city ? cityName(city, locale) : branch.citySlug}</p>
                <p dir="auto" className="text-sm text-foreground-muted break-words text-pretty">
                  {branch.address}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RentalConditions({ conditions, locale, className }: { conditions: FleetConditions; locale: Locale; className?: string }) {
  const t = useTranslations("Storefront.rental");
  const criteria = useTranslations("Criteria");
  type Key = Parameters<typeof criteria>[0];
  const price = (amount: number) => formatPrice(amount, locale);
  const items: { id: string; icon: LucideIcon; title: string; detail?: string }[] = [];
  const driver = [
    conditions.minAge !== null ? t("age", { age: conditions.minAge }) : undefined,
    conditions.licenceYears !== null && conditions.licenceYears > 0 ? t("licence", { count: conditions.licenceYears }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (driver) items.push({ id: "driver", icon: IdCard, title: t("driver"), detail: driver });
  if (conditions.deposit)
    items.push({
      id: "deposit",
      icon: Wallet,
      title:
        conditions.deposit.min === conditions.deposit.max
          ? t("deposit", { amount: price(conditions.deposit.min) })
          : t("depositRange", { min: price(conditions.deposit.min), max: price(conditions.deposit.max) }),
      detail: t("depositHint"),
    });
  if (conditions.insurance.length > 0)
    items.push({
      id: "insurance",
      icon: ShieldCheck,
      title: t("insurance"),
      detail: list(
        conditions.insurance.map((value) => criteria(`rental-insurance.options.${value}` as Key)),
        locale,
      ),
    });
  if (conditions.handover.length > 0 || conditions.oneWay)
    items.push({
      id: "handover",
      icon: KeyRound,
      title: t("handover"),
      detail: [
        list(
          conditions.handover.map((value) => criteria(`vehicle-handover.options.${value}` as Key)),
          locale,
        ),
        conditions.oneWay ? t("oneWay") : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="rental-conditions" data-testid="rental-conditions" className={cn("flex flex-col gap-4", className)}>
      <h2 id="rental-conditions" className="text-xl font-semibold">
        {t("conditionsTitle")}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map(({ id, icon, title, detail }) => (
          <li key={id} data-testid={`rental-condition-${id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
            <Badge icon={icon} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{title}</span>
              {detail ? <span className="text-sm text-foreground-muted text-pretty">{detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 text-xs text-foreground-muted text-pretty">
        <BadgeInfo className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        {t("conditionsNote")}
      </p>
    </section>
  );
}

function Badge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
      <Icon className="size-[1.125rem]" />
    </span>
  );
}

function Row({ icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Badge icon={icon} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-foreground-muted text-pretty">{children}</p>
      </div>
    </div>
  );
}
