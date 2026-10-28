import { CalendarClock, CarFront, Gauge, IdCard, KeyRound, ShieldCheck, TrendingDown, Wallet, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import type { Locale } from "@/config/site";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { formatPrice } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// Rental terms of a car rental listing (rental pack, design location-voitures/location-voitures.md
// §2): mileage, minimum length, insurance, deposit, driver, handover, long-term rates and the fleet,
// as highlights; options as chips. Nothing filled, nothing shown. Every term is the agency's
// declaration, said under the section: the agency's written contract prevails.

export interface RentalTermsProps {
  subcategoryId: string;
  attributes: ListingAttributes;
  locale: Locale;
  className?: string;
}

interface Highlight {
  id: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function RentalTerms({ subcategoryId, attributes, locale, className }: RentalTermsProps) {
  const t = useTranslations("Criteria");
  const r = useTranslations("ListingPage.rental");
  if (subcategoryId !== RENTAL_SUBCATEGORY) return null;
  type Key = Parameters<typeof t>[0];
  const option = (id: string, value: string) => t(`${id}.options.${value}` as Key);
  const price = (amount: number) => formatPrice(amount, locale);

  const highlights: Highlight[] = [];
  const policy = attributes["mileage-policy"];
  const km = num(attributes["km-per-day"]);
  if (policy === "illimite") highlights.push({ id: "mileage", icon: Gauge, title: r("unlimited") });
  else if (policy === "limite" && km !== undefined) highlights.push({ id: "mileage", icon: Gauge, title: r("limited", { km }) });
  const minDays = num(attributes["min-rental-days"]);
  if (minDays !== undefined && minDays > 1) highlights.push({ id: "min-days", icon: CalendarClock, title: r("minDays", { count: minDays }) });
  const insurance = attributes["rental-insurance"];
  if (typeof insurance === "string") {
    const excess = num(attributes["insurance-excess"]);
    highlights.push({ id: "insurance", icon: ShieldCheck, title: option("rental-insurance", insurance), ...(insurance === "tous-risques-franchise" && excess !== undefined ? { detail: r("excess", { amount: price(excess) }) } : {}) });
  }
  const deposit = num(attributes["rental-deposit"]);
  if (deposit !== undefined) highlights.push({ id: "deposit", icon: Wallet, title: r("deposit", { amount: price(deposit) }), detail: r("depositHint") });
  const age = num(attributes["driver-min-age"]);
  const licence = num(attributes["licence-years"]);
  const driver = [age !== undefined ? r("age", { count: age }) : undefined, licence !== undefined && licence > 0 ? r("licence", { count: licence }) : undefined].filter(Boolean).join(" · ");
  if (driver) highlights.push({ id: "driver", icon: IdCard, title: r("driver"), detail: driver });
  const handover = list(attributes["vehicle-handover"]);
  const oneWay = attributes["one-way"] === true;
  if (handover.length > 0 || oneWay) {
    const places = handover.map((place) => option("vehicle-handover", place)).join(locale === "ar" ? "، " : ", ");
    highlights.push({ id: "handover", icon: KeyRound, title: places || r("handover"), ...(oneWay ? { detail: r("oneWay") } : {}) });
  }
  const week = num(attributes["rate-7-days"]);
  const month = num(attributes["rate-30-days"]);
  const rates = [week !== undefined ? r("rate7", { amount: price(week) }) : undefined, month !== undefined ? r("rate30", { amount: price(month) }) : undefined].filter(Boolean).join(" · ");
  if (rates) highlights.push({ id: "rates", icon: TrendingDown, title: r("rates"), detail: rates });
  const fleet = num(attributes["fleet-units"]);
  if (fleet !== undefined && fleet > 1) highlights.push({ id: "fleet", icon: CarFront, title: r("fleet", { count: fleet }) });
  const extras = list(attributes["rental-extras"]);

  if (highlights.length === 0 && extras.length === 0) return null;

  return (
    <section data-testid="rental-terms" aria-labelledby="rental-terms-title" className={cn("flex flex-col gap-5", className)}>
      <h2 id="rental-terms-title" className="text-lg font-semibold">
        {r("title")}
      </h2>
      {highlights.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {highlights.map(({ id, icon: Icon, title, detail }) => (
            <li key={id} data-testid={`rental-${id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
              <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
                <Icon className="size-[1.125rem]" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{title}</span>
                {detail ? <span className="text-sm text-foreground-muted text-pretty">{detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {extras.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <h3 className="text-sm font-semibold">{r("extras")}</h3>
          <ul className="flex flex-wrap gap-2">
            {extras.map((item) => (
              <li key={item} className="rounded-full border border-border px-3 py-1 text-sm">
                {option("rental-extras", item)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-foreground-muted text-pretty">{r("declared")}</p>
    </section>
  );
}
