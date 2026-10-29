"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { intlLocale } from "@/lib/listings/client/format";
import { dayNumber, dayString } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";

// Month grids of a car rental's availability (rental pack §3), Monday first, Morocco's calendar.
// Read-only on the listing page; editable in the agency's calendar, where a first tap marks the
// start of a period and a second tap applies it (the same day twice toggles that day alone).

export interface AvailabilityCalendarProps {
  locale: Locale;
  /** Today in Morocco (day number): earlier days are greyed out. */
  today: number;
  /** Last day shown as selectable (the blocking horizon); later days are greyed out. */
  lastDay: number;
  blocked: ReadonlySet<number>;
  /** First month shown, as months after today's month (0 = this month). */
  monthOffset: number;
  /** Months side by side on wide screens (stacked on phones). */
  months: number;
  /** Editable: the tapped day. */
  onDay?: (day: number) => void;
  /** Editable: the start of a period being chosen. */
  anchor?: number | null;
  /** Month navigation; the buttons are hidden without it. */
  onMonthOffset?: (offset: number) => void;
  maxMonthOffset?: number;
}

/** Day number of the first day of the month `offset` months after the month of `day`. */
function monthStart(day: number, offset: number): number {
  const [year, month] = dayString(day).split("-").map(Number) as [number, number];
  return dayNumber(new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10));
}

/** 0 = Monday ... 6 = Sunday (1970-01-01 was a Thursday). */
const weekdayIndex = (day: number) => (((day + 3) % 7) + 7) % 7;

export function AvailabilityCalendar({ locale, today, lastDay, blocked, monthOffset, months, onDay, anchor = null, onMonthOffset, maxMonthOffset = 11 }: AvailabilityCalendarProps) {
  const t = useTranslations("Rental.calendar");
  const tag = intlLocale(locale);
  const monthFormat = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" });
  const weekdayFormat = new Intl.DateTimeFormat(tag, { weekday: "narrow", timeZone: "UTC" });
  const weekdayLong = new Intl.DateTimeFormat(tag, { weekday: "long", timeZone: "UTC" });
  const dayFormat = new Intl.DateTimeFormat(tag, { day: "numeric", timeZone: "UTC" });
  const fullFormat = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  // A known Monday (1970-01-05) gives the weekday headers in the page's language.
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date((4 + index) * 86_400_000));
  const editable = onDay !== undefined;

  return (
    <div className="flex flex-col gap-3">
      {onMonthOffset ? (
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="icon" disabled={monthOffset <= 0} aria-label={t("previous")} onClick={() => onMonthOffset(monthOffset - 1)}>
            <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={monthOffset >= maxMonthOffset} aria-label={t("next")} onClick={() => onMonthOffset(monthOffset + 1)}>
            <ChevronRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
        </div>
      ) : null}
      <div className={cn("grid gap-6", months > 1 && "sm:grid-cols-2")}>
        {Array.from({ length: months }, (_, index) => {
          const first = monthStart(today, monthOffset + index);
          const next = monthStart(today, monthOffset + index + 1);
          const lead = weekdayIndex(first);
          const days = Array.from({ length: next - first }, (_, offset) => first + offset);
          const label = monthFormat.format(new Date(first * 86_400_000));
          return (
            <section key={first} aria-label={label} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold capitalize">{label}</h3>
              <div className="grid grid-cols-7 gap-1 text-center text-xs text-foreground-muted" aria-hidden="true">
                {weekdays.map((weekday) => (
                  <span key={weekday.getTime()} title={weekdayLong.format(weekday)}>
                    {weekdayFormat.format(weekday)}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: lead }, (_, pad) => (
                  <span key={`pad-${pad}`} aria-hidden="true" />
                ))}
                {days.map((day) => {
                  const date = new Date(day * 86_400_000);
                  const off = day < today || day > lastDay;
                  const isBlocked = blocked.has(day);
                  const status = off ? t("past") : isBlocked ? t("blocked") : t("free");
                  const cell = cn(
                    "flex aspect-square min-h-9 items-center justify-center rounded-md text-sm tabular-nums",
                    off && "text-foreground-muted/50",
                    !off && isBlocked && "bg-danger-surface text-danger line-through decoration-danger/60",
                    !off && !isBlocked && "bg-success-surface text-foreground",
                    day === today && "ring-1 ring-structure ring-inset font-semibold",
                    anchor === day && "ring-2 ring-primary ring-inset",
                  );
                  if (!editable || off) {
                    return (
                      <span key={day} className={cell} data-day={dayString(day)} data-state={off ? "off" : isBlocked ? "blocked" : "free"}>
                        <span aria-hidden="true">{dayFormat.format(date)}</span>
                        <span className="sr-only">{`${fullFormat.format(date)} : ${status}`}</span>
                      </span>
                    );
                  }
                  return (
                    <button
                      key={day}
                      type="button"
                      className={cn(cell, "cursor-pointer outline-none transition-colors hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring")}
                      aria-pressed={isBlocked}
                      aria-label={`${fullFormat.format(date)} : ${status}`}
                      data-day={dayString(day)}
                      data-state={isBlocked ? "blocked" : "free"}
                      onClick={() => onDay(day)}
                    >
                      {dayFormat.format(date)}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-muted">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-3 rounded-sm bg-success-surface ring-1 ring-success/40 ring-inset" />
          {t("legendFree")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-3 rounded-sm bg-danger-surface ring-1 ring-danger/40 ring-inset" />
          {t("legendBlocked")}
        </li>
      </ul>
    </div>
  );
}
