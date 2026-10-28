"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { inputClassName } from "@/components/ui/input";
import { dayNumber, dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { RENTAL_SEARCH_AHEAD_DAYS, RENTAL_SEARCH_DAYS_MAX, type RentalDates } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// Pick-up and return days of a car rental search (rental pack §4): native date fields (the
// phone's own picker), Morocco's calendar, a pick-up from today to 180 days ahead and a return
// up to 60 days later (the same day counts as one day). A pick-up after the return moves the
// return to the next day.

export interface RentalDatesFieldsProps {
  value: Partial<RentalDates>;
  onChange: (value: Partial<RentalDates>) => void;
  className?: string;
  /** Field names of a GET form (the home module). */
  names?: { from: string; to: string };
  inputClassName?: string;
}

export function RentalDatesFields({ value, onChange, className, names, inputClassName: fieldClassName }: RentalDatesFieldsProps) {
  const t = useTranslations("Rental.search");
  const ids = useId();
  const [today] = useState(() => moroccoToday(Date.now()));
  const from = value.from ? dayNumber(value.from) : Number.NaN;
  const minReturn = Number.isNaN(from) ? today : from;
  const maxReturn = Number.isNaN(from) ? today + RENTAL_SEARCH_AHEAD_DAYS + RENTAL_SEARCH_DAYS_MAX : from + RENTAL_SEARCH_DAYS_MAX;

  function setFrom(next: string) {
    if (!next) return onChange({ ...value, from: undefined });
    const start = dayNumber(next);
    const end = value.to ? dayNumber(value.to) : Number.NaN;
    // Keep the return when it still fits, else the next day.
    const to = !Number.isNaN(end) && end >= start && end - start <= RENTAL_SEARCH_DAYS_MAX ? value.to : dayString(start + 1);
    onChange({ from: next, to });
  }

  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-from`} className="text-xs text-foreground-muted">
          {t("from")}
        </label>
        <input
          id={`${ids}-from`}
          type="date"
          name={names?.from}
          className={cn(inputClassName, "min-w-0", fieldClassName)}
          value={value.from ?? ""}
          min={dayString(today)}
          max={dayString(today + RENTAL_SEARCH_AHEAD_DAYS)}
          onChange={(event) => setFrom(event.target.value)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-to`} className="text-xs text-foreground-muted">
          {t("to")}
        </label>
        <input
          id={`${ids}-to`}
          type="date"
          name={names?.to}
          className={cn(inputClassName, "min-w-0", fieldClassName)}
          value={value.to ?? ""}
          min={dayString(minReturn)}
          max={dayString(maxReturn)}
          onChange={(event) => onChange({ ...value, to: event.target.value || undefined })}
        />
      </div>
    </div>
  );
}

/** Both days set and in order: the dates a search can carry. */
export function completeDates(value: Partial<RentalDates>): RentalDates | undefined {
  if (!value.from || !value.to) return undefined;
  const from = dayNumber(value.from);
  const to = dayNumber(value.to);
  return !Number.isNaN(from) && !Number.isNaN(to) && to >= from && to - from <= RENTAL_SEARCH_DAYS_MAX ? { from: value.from, to: value.to } : undefined;
}
