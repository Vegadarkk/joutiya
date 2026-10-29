"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import type { RentalAvailability } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import { formatDate } from "@/lib/listings/client/format";
import { isFresh } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";
import { AvailabilityDialog } from "./availability-dialog";

// "Mes annonces" row of a car rental: when its availability was last confirmed, and the button
// that opens the agency's calendar (rental pack §3).

export function OwnerAvailability({ listingId, title, rental: initial, now }: { listingId: string; title: string; rental: RentalAvailability; now: Date }) {
  const t = useTranslations("Rental.availability");
  const locale = useLocale() as Locale;
  const [rental, setRental] = useState(initial);
  const [open, setOpen] = useState(false);
  const fresh = isFresh(rental.updatedAt ? Date.parse(rental.updatedAt) : null, now);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className={cn("text-xs text-pretty", fresh ? "text-foreground-muted" : "font-medium text-warning")} data-testid="owner-availability">
        {rental.updatedAt ? (fresh ? t("updatedOn", { date: formatDate(new Date(rental.updatedAt), locale) }) : t("stale", { date: formatDate(new Date(rental.updatedAt), locale) })) : t("never")}
      </p>
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" aria-label={t("openOf", { title: isolate(title) })} onClick={() => setOpen(true)}>
        <CalendarDays aria-hidden="true" />
        {t("open")}
      </Button>
      {open ? <AvailabilityDialog listingId={listingId} title={title} rental={rental} onClose={() => setOpen(false)} onSaved={setRental} /> : null}
    </div>
  );
}
