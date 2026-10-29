"use client";

import { useState, type FormEvent } from "react";
import { CalendarDays, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchNavigation } from "@/components/search/search-navigation";
import { Button } from "@/components/ui/button";
import { datedRental } from "@/config/categories";
import { canonicalSearchParams, type RentalDates, type SearchParams } from "@/lib/search/params";
import { RentalDatesFields, completeDates } from "./rental-dates-fields";

// Results of a rental by dates (rental pack §4; a home: seasonal rental conception §2): the dates up
// front, above the results, and the estimate notice once they apply (the totals on the cards are
// estimates; the agency's contract, or the host's confirmation, prevails).

export function RentalDatesBar({ params }: { params: SearchParams }) {
  const t = useTranslations("Rental.search");
  const navigation = useSearchNavigation();
  const unit = datedRental(params.subcategory)?.unit ?? "day";
  const key = (name: "barTitle" | "submit" | "note") => (unit === "night" ? (`home.${name}` as const) : name);
  const [value, setValue] = useState<Partial<RentalDates>>(params.dates ?? {});
  const dates = completeDates(value, unit);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dates) navigation?.navigate(canonicalSearchParams({ ...params, dates, page: undefined }));
  }

  return (
    <form onSubmit={submit} data-testid="rental-dates-bar" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CalendarDays aria-hidden="true" className="size-5 text-structure" />
        {t(key("barTitle"))}
      </h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <RentalDatesFields value={value} onChange={setValue} className="sm:flex-1" unit={unit} />
        <Button type="submit" disabled={!dates}>
          <Search aria-hidden="true" />
          {t(key("submit"))}
        </Button>
      </div>
      {params.dates ? <p className="text-xs text-foreground-muted text-pretty">{t(key("note"))}</p> : null}
    </form>
  );
}
