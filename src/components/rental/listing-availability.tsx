"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHydrated } from "@/components/auth/use-hydrated";
import { Skeleton } from "@/components/ui/skeleton";
import type { RentalUnit } from "@/config/categories";
import type { Locale } from "@/config/site";
import type { RentalAvailability } from "@/lib/contracts/listings";
import { formatDate } from "@/lib/listings/client/format";
import { RENTAL_AHEAD_DAYS, blockedSet, isFresh, moroccoToday } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";
import { AvailabilityCalendar } from "./availability-calendar";

// The listing page's availability block (rental pack §3; a holiday home: seasonal rental conception
// §2, its nights): this month and the next, as declared by the agency or the host. The page is cached (ISR), so the days are drawn in the browser, on today's date.

export function ListingAvailability({ rental, locale, unit = "day" }: { rental: RentalAvailability; locale: Locale; unit?: RentalUnit }) {
  const t = useTranslations("Rental.listing");
  const hydrated = useHydrated();
  const [monthOffset, setMonthOffset] = useState(0);
  // Server and hydration render a skeleton; the browser's clock then draws the days.
  const [clock] = useState(() => Date.now());
  const now = hydrated ? clock : null;
  const fresh = now !== null && isFresh(rental.updatedAt ? Date.parse(rental.updatedAt) : null, now);
  const today = now === null ? 0 : moroccoToday(now);
  const text = (key: "updatedOn" | "stale" | "never" | "note") => (unit === "night" ? (`home.${key}` as const) : key);
  return (
    <section data-testid="rental-availability" aria-labelledby="rental-availability-title" className="flex flex-col gap-4">
      <h2 id="rental-availability-title" className="flex items-center gap-2 text-lg font-semibold">
        <CalendarDays aria-hidden="true" className="size-5 text-structure" />
        {t("title")}
      </h2>
      {now === null ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <>
          <p className={cn("text-sm text-pretty", fresh ? "text-foreground-muted" : "font-medium text-warning")} data-testid="rental-availability-freshness">
            {rental.updatedAt
              ? t(text(fresh ? "updatedOn" : "stale"), { date: formatDate(new Date(rental.updatedAt), locale) })
              : t(text("never"))}
          </p>
          <AvailabilityCalendar
            locale={locale}
            today={today}
            lastDay={today + RENTAL_AHEAD_DAYS - 1}
            blocked={blockedSet(rental.unavailable)}
            monthOffset={monthOffset}
            months={2}
            onMonthOffset={setMonthOffset}
            maxMonthOffset={10}
          />
        </>
      )}
      <p className="text-xs text-foreground-muted text-pretty">{t(text("note"))}</p>
    </section>
  );
}
