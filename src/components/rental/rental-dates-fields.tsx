"use client";

import { useId, useState, type MouseEvent } from "react";
import { CalendarDays } from "lucide-react";
import { useTranslations } from "next-intl";
import { inputClassName } from "@/components/ui/input";
import type { RentalUnit } from "@/config/categories";
import { RENTAL_SEARCH_AHEAD_DAYS, RENTAL_SEARCH_DAYS_MAX, dayNumber, dayString, moroccoToday } from "@/lib/listings/rental-availability";
import type { RentalDates } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// Pick-up and return days of a car rental search (rental pack §4): native date fields (the
// phone's own picker), Morocco's calendar, a pick-up from today to 180 days ahead and a return
// up to 60 days later (the same day counts as one day). A pick-up after the return moves the
// return to the next day. A home (`unit` "night", seasonal rental conception §2): arrival and
// departure, one night at least. The fields stay native (the phone's own picker, the browser's own
// date order) but dress like the city field: a calendar glyph in place of the browser's indicator,
// and a click anywhere in the field opens the picker where the browser allows it (UX audit, 12).

/** Hides the browser's own indicator; the glyph beside the field stands for it. */
const DATE_INPUT = "min-w-0 ps-9 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-date-and-time-value]:text-start";

function openPicker(event: MouseEvent<HTMLInputElement>) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Not a user gesture for the browser, or no picker here: the field still takes typed input.
  }
}

export interface RentalDatesFieldsProps {
  value: Partial<RentalDates>;
  onChange: (value: Partial<RentalDates>) => void;
  className?: string;
  /** Field names of a GET form (the home module). */
  names?: { from: string; to: string };
  inputClassName?: string;
  /** "night": a stay's arrival and departure (the departure comes after the arrival). */
  unit?: RentalUnit;
}

export function RentalDatesFields({ value, onChange, className, names, inputClassName: fieldClassName, unit = "day" }: RentalDatesFieldsProps) {
  const t = useTranslations("Rental.search");
  const ids = useId();
  const [today] = useState(() => moroccoToday(Date.now()));
  const from = value.from ? dayNumber(value.from) : Number.NaN;
  const nights = unit === "night";
  const minReturn = (Number.isNaN(from) ? today : from) + (nights ? 1 : 0);
  const maxReturn = Number.isNaN(from) ? today + RENTAL_SEARCH_AHEAD_DAYS + RENTAL_SEARCH_DAYS_MAX : from + RENTAL_SEARCH_DAYS_MAX;

  function setFrom(next: string) {
    if (!next) return onChange({ ...value, from: undefined });
    const start = dayNumber(next);
    const end = value.to ? dayNumber(value.to) : Number.NaN;
    // Keep the return when it still fits, else the next day.
    const to = !Number.isNaN(end) && end >= start + (nights ? 1 : 0) && end - start <= RENTAL_SEARCH_DAYS_MAX ? value.to : dayString(start + 1);
    onChange({ from: next, to });
  }

  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-from`} className="text-xs text-foreground-muted">
          {t(nights ? "home.from" : "from")}
        </label>
        <span className="relative flex">
          <CalendarDays className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-structure dark:text-gold-300" aria-hidden="true" />
          <input
            id={`${ids}-from`}
            type="date"
            name={names?.from}
            className={cn(inputClassName, DATE_INPUT, fieldClassName)}
            value={value.from ?? ""}
            min={dayString(today)}
            max={dayString(today + RENTAL_SEARCH_AHEAD_DAYS)}
            onChange={(event) => setFrom(event.target.value)}
            onClick={openPicker}
          />
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-to`} className="text-xs text-foreground-muted">
          {t(nights ? "home.to" : "to")}
        </label>
        <span className="relative flex">
          <CalendarDays className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-structure dark:text-gold-300" aria-hidden="true" />
          <input
            id={`${ids}-to`}
            type="date"
            name={names?.to}
            className={cn(inputClassName, DATE_INPUT, fieldClassName)}
            value={value.to ?? ""}
            min={dayString(minReturn)}
            max={dayString(maxReturn)}
            onChange={(event) => onChange({ ...value, to: event.target.value || undefined })}
            onClick={openPicker}
          />
        </span>
      </div>
    </div>
  );
}

/** Both days set and in order (a stay: one night at least): the dates a search can carry. */
export function completeDates(value: Partial<RentalDates>, unit: RentalUnit = "day"): RentalDates | undefined {
  if (!value.from || !value.to) return undefined;
  const from = dayNumber(value.from);
  const to = dayNumber(value.to);
  const first = from + (unit === "night" ? 1 : 0);
  return !Number.isNaN(from) && !Number.isNaN(to) && to >= first && to - from <= RENTAL_SEARCH_DAYS_MAX ? { from: value.from, to: value.to } : undefined;
}
