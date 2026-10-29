"use client";

import { useMemo, useState } from "react";
import { ArrowRight, CalendarCheck, CalendarX, Fuel, ImageOff, Settings2, Users, X } from "lucide-react";
import { LISTING_CARD_SIZES } from "@/components/listing/listing-card";
import { blurhashPlaceholder, photoSources } from "@/components/listing/photo";
import { PriceTag } from "@/components/listing/price-tag";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { quietLinkClassName, textLinkClassName } from "@/components/ui/text-link";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { cityBySlug, cityName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { formatPrice } from "@/lib/listings/client/format";
import { rentalDuration, searchPath, type RentalDates } from "@/lib/search/params";
import { fleetDates, vehicleAvailable, vehicleTotal, type FleetVehicle, type RentalFleetView } from "@/lib/search/rental-fleet-view";
import { cn } from "@/lib/utils";
import { RentalDatesFields } from "./rental-dates-fields";

// The fleet of a car rental agency's storefront (rental pack §5), by vehicle category, each with
// its day price, gearbox, fuel and seats. The renter's dates and the branch city filter the grid
// in place (no request: the blocked days came with the page): the vehicles free on every day come
// first, the others stay visible, marked. A vehicle whose availability is older than 14 days
// reads « à confirmer » (decision 4). The search keeps the cross-agency comparison.

const OTHER = "_other";

/** Criterion labels, translated on the server (the public pages ship no criteria catalog). */
export interface FleetLabels {
  /** Vehicle categories in display order, with their label. */
  classes: { id: string; label: string }[];
  gearbox: Record<string, string>;
  fuel: Record<string, string>;
}

interface Props {
  fleet: RentalFleetView;
  labels: FleetLabels;
  shopPublicId: string;
  mediaBaseUrl: string | null;
  locale: Locale;
}

type Status = "free" | "blocked" | null;

export function RentalFleet({ fleet, labels, shopPublicId, mediaBaseUrl, locale }: Props) {
  const t = useNumbersTranslations("Storefront.fleet");
  const [dates, setDates] = useState<Partial<RentalDates>>({});
  const [city, setCity] = useState("");
  // Today, once per mount (as the date fields' bounds).
  const [now] = useState(() => Date.now());
  const active = fleetDates(dates, now);

  const cities = useMemo(() => [...new Set(fleet.vehicles.map((vehicle) => vehicle.citySlug).filter((slug): slug is string => slug !== null))], [fleet.vehicles]);
  const shown = fleet.vehicles.filter((vehicle) => !city || vehicle.citySlug === city);
  const statusOf = (vehicle: FleetVehicle): Status => (active ? (vehicleAvailable(vehicle, active) ? "free" : "blocked") : null);
  const free = active ? shown.filter((vehicle) => statusOf(vehicle) === "free").length : 0;

  // Categories in the criterion's order, then the vehicles without one; free ones first within each.
  const order = [...labels.classes.map((item) => item.id), OTHER];
  const groups = order
    .map((id) => ({
      id,
      vehicles: shown
        .filter((vehicle) => (vehicle.rentalClass && order.includes(vehicle.rentalClass) ? vehicle.rentalClass : OTHER) === id)
        .sort((a, b) => Number(statusOf(a) === "blocked") - Number(statusOf(b) === "blocked")),
    }))
    .filter((group) => group.vehicles.length > 0);

  const compare = searchPath({ category: "vehicules", subcategory: RENTAL_SUBCATEGORY, ...(active ? { dates: active } : {}), ...(city ? { city } : {}) });
  const all = searchPath({ category: "vehicules", subcategory: RENTAL_SUBCATEGORY, shop: shopPublicId, ...(active ? { dates: active } : {}), ...(city ? { city } : {}) });

  return (
    <section aria-labelledby="rental-fleet" data-testid="rental-fleet" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="rental-fleet" className="text-2xl font-semibold">
          {t("fleetTitle")}
        </h2>
        <p className="text-sm text-foreground-muted tabular-nums">{t("fleetCount", { count: fleet.total })}</p>
      </div>

      {/* The renter's dates and agency: the grid answers at once. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-brand p-4 sm:p-5">
        <p className="text-sm font-medium">{t("filterLead")}</p>
        <div className={cn("grid gap-2 sm:items-end", cities.length > 1 ? "sm:grid-cols-[1.4fr_1fr_auto]" : "sm:grid-cols-[1.4fr_auto]")}>
          <RentalDatesFields value={dates} onChange={setDates} inputClassName="h-11" />
          {cities.length > 1 ? (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {t("city")}
              <select data-testid="rental-fleet-city" value={city} onChange={(event) => setCity(event.target.value)} className={cn(inputClassName, "h-11")}>
                <option value="">{t("allCities")}</option>
                {cities.map((slug) => {
                  const found = cityBySlug(slug);
                  return (
                    <option key={slug} value={slug}>
                      {found ? cityName(found, locale) : slug}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}
          {dates.from || dates.to || city ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                setDates({});
                setCity("");
              }}
            >
              <X aria-hidden="true" />
              {t("reset")}
            </Button>
          ) : null}
        </div>
        <p aria-live="polite" data-testid="rental-fleet-summary" className="text-sm text-foreground-muted tabular-nums">
          {active ? (free > 0 ? t("freeCount", { count: free }) : t("noneFree")) : null}
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t("noMatch")}</p>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`fleet-class-${group.id}`} data-testid="rental-fleet-class" data-class={group.id} className="flex flex-col gap-4">
              <h3 id={`fleet-class-${group.id}`} className="flex items-baseline gap-2 border-b border-border pb-2 text-lg font-semibold">
                {labels.classes.find((item) => item.id === group.id)?.label ?? t("otherClass")}
                <span className="text-sm font-normal text-foreground-muted tabular-nums">{group.vehicles.length}</span>
              </h3>
              <ul className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.vehicles.map((vehicle) => (
                  <li key={vehicle.id} className="min-w-0">
                    <FleetCard vehicle={vehicle} labels={labels} status={statusOf(vehicle)} dates={active} mediaBaseUrl={mediaBaseUrl} locale={locale} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 text-sm">
        {fleet.total > fleet.vehicles.length ? <p className="text-foreground-muted">{t("truncated", { shown: fleet.vehicles.length })}</p> : null}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href={all} className={cn("inline-flex items-center gap-1 font-medium text-link", textLinkClassName)}>
            {t("seeInSearch")}
            <ArrowRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          </Link>
          <Link href={compare} className={cn("inline-flex items-center gap-1 font-medium text-link", textLinkClassName)}>
            {t("compare")}
            <ArrowRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
          </Link>
        </div>
        <p className="text-xs text-foreground-muted text-pretty">{t("fleetNote")}</p>
      </div>
    </section>
  );
}

function FleetCard({
  vehicle,
  labels,
  status,
  dates,
  mediaBaseUrl,
  locale,
}: {
  vehicle: FleetVehicle;
  labels: FleetLabels;
  status: Status;
  dates: RentalDates | null;
  mediaBaseUrl: string | null;
  locale: Locale;
}) {
  const t = useNumbersTranslations("Storefront.fleet");
  const card = useNumbersTranslations("ListingCard");
  const sources = vehicle.photo ? photoSources(mediaBaseUrl, vehicle.id, vehicle.photo, "s") : null;
  const placeholder = blurhashPlaceholder(vehicle.photo?.blurhash);
  const city = vehicle.citySlug ? cityBySlug(vehicle.citySlug) : undefined;
  const total = dates && status === "free" ? vehicleTotal(vehicle, dates) : null;
  const specs = [
    vehicle.gearbox && labels.gearbox[vehicle.gearbox] ? { icon: Settings2, text: labels.gearbox[vehicle.gearbox]! } : null,
    vehicle.fuel && labels.fuel[vehicle.fuel] ? { icon: Fuel, text: labels.fuel[vehicle.fuel]! } : null,
    vehicle.seats !== null ? { icon: Users, text: t("seats", { count: vehicle.seats }) } : null,
  ].filter((spec) => spec !== null);

  return (
    <article
      data-testid="fleet-card"
      data-vehicle={vehicle.id}
      data-status={status ?? undefined}
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface transition-[border-color,opacity] duration-150 hover:border-structure has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring dark:hover:border-gold-300",
        status === "blocked" && "opacity-60 hover:opacity-100",
      )}
    >
      <div className="relative aspect-[16/10] bg-surface-muted bg-cover bg-center" style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}>
        {sources ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sources.src}
            srcSet={sources.srcSet}
            sizes={LISTING_CARD_SIZES}
            width={sources.width}
            height={sources.height}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-foreground-muted">
            <ImageOff className="size-6" aria-hidden="true" strokeWidth={1.5} />
            <span className="text-xs">{card("noPhoto")}</span>
          </span>
        )}
        {status ? (
          <span
            data-testid="fleet-card-status"
            className={cn(
              "absolute top-2 start-2 inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-semibold",
              status === "free" ? "bg-structure text-structure-foreground" : "bg-bab-950/75 text-cream-100",
            )}
          >
            {status === "free" ? <CalendarCheck className="size-3.5" aria-hidden="true" /> : <CalendarX className="size-3.5" aria-hidden="true" />}
            {status === "free" ? t("free") : t("blocked")}
          </span>
        ) : null}
        {vehicle.example ? <span className="absolute bottom-2 start-2 rounded-sm bg-featured px-2 py-0.5 text-xs font-semibold text-featured-foreground">{card("example")}</span> : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <h4 className="text-sm font-medium leading-snug ltr:text-left rtl:text-right">
          <Link
            href={`/annonce/${vehicle.slugId}`}
            prefetch={false}
            dir="auto"
            className={cn("line-clamp-2 break-words outline-none", quietLinkClassName, "group-hover:decoration-current after:absolute after:inset-0")}
          >
            {vehicle.title}
          </Link>
        </h4>
        {specs.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-muted">
            {specs.map(({ icon: Icon, text }) => (
              <li key={text} className="inline-flex items-center gap-1">
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex flex-col gap-0.5 pt-1">
          <PriceTag price={vehicle.price} isDonation={false} unit="day" locale={locale} />
          {total !== null && dates ? <p className="text-xs font-medium tabular-nums">{card("rentalTotal", { days: rentalDuration(dates), total: formatPrice(total, locale) })}</p> : null}
          {vehicle.minDays !== null && vehicle.minDays > 1 ? <p className="text-xs text-foreground-muted">{t("minDays", { count: vehicle.minDays })}</p> : null}
          <p className="flex flex-wrap gap-x-2 text-xs text-foreground-muted">
            {city ? <span>{cityName(city, locale)}</span> : null}
            {vehicle.fresh ? null : <span className="text-warning">{card("rentalToConfirm")}</span>}
          </p>
        </div>
      </div>
    </article>
  );
}
