"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { CalendarDays, MapPin, ShieldCheck, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { SITE_NAME, type Locale } from "@/config/site";
import {
  APPOINTMENT_DURATIONS,
  APPOINTMENT_HORIZON_MS,
  APPOINTMENT_KINDS,
  APPOINTMENT_LEAD_MS,
  APPOINTMENT_PLACE_MAX,
  APPOINTMENT_SLOTS_MAX,
  type AppointmentDuration,
  type AppointmentKind,
  type Slot,
} from "@/lib/contracts/appointments";
import { slotEnd, slotsProblem, sortSlots } from "@/lib/appointments/rules";
import { moroccoClock, moroccoTime, nextDays } from "@/lib/appointments/time";
import { cn } from "@/lib/utils";
import { dayTile, formatDayKey, formatSlotClock, formatSlotDay, formatSlotRange } from "./format";

// The slot picker (architecture §5, 28 Oct): pure, no request. The proposer picks the kind, a day
// in the strip (the next two weeks as small doors, any later day up to 60 days with the date
// field), then up to 5 start times on a half-hour grid in Morocco's time, a duration and an
// optional place. Times that start within the hour or overlap a picked slot are off. The packs
// reuse it: Concession passes defaultKind "test_drive", Agence "visit".

export interface SlotPickerValue {
  kind: AppointmentKind;
  slots: Slot[];
  place?: string;
}

export interface SlotPickerProps {
  defaultKind?: AppointmentKind;
  /** Kinds offered, in this order (all by default). */
  kinds?: readonly AppointmentKind[];
  submitting?: boolean;
  /** The last refusal, already translated. */
  error?: string | null;
  onSubmit: (value: SlotPickerValue) => void;
  onCancel?: () => void;
  /** Tests: the clock. */
  now?: number;
}

/** Start times of the grid, in minutes after midnight: 08:00 to 21:30 every 30 minutes. */
export const GRID_MINUTES: readonly number[] = Array.from({ length: 28 }, (_, index) => 8 * 60 + index * 30);
const STRIP_DAYS = 14;

/** A grid time is off: too soon or too far, or it overlaps a picked slot (its own start excepted). */
export function timeOff(start: number, minutes: AppointmentDuration, picked: readonly Slot[], now: number): boolean {
  if (start < now + APPOINTMENT_LEAD_MS || start > now + APPOINTMENT_HORIZON_MS) return true;
  const candidate = { start, minutes };
  return picked.some((slot) => slot.start !== start && slot.start < slotEnd(candidate) && start < slotEnd(slot));
}

/** The first day of the strip with a time still open. */
export function firstOpenDay(days: readonly string[], now: number): string {
  return days.find((day) => GRID_MINUTES.some((minutes) => moroccoTime(day, minutes) >= now + APPOINTMENT_LEAD_MS)) ?? days[0] ?? moroccoClock(now).day;
}

export function SlotPicker({ defaultKind = "meeting", kinds = APPOINTMENT_KINDS, submitting, error, onSubmit, onCancel, now: fixedNow }: SlotPickerProps) {
  const t = useTranslations("Appointments.picker");
  const kindLabel = useTranslations("Appointments.kind");
  const durationLabel = useTranslations("Appointments.duration");
  const locale = useLocale() as Locale;
  const id = useId();
  const [now] = useState(() => fixedNow ?? Date.now());
  const days = useMemo(() => nextDays(now, STRIP_DAYS), [now]);
  const lastDay = useMemo(() => moroccoClock(now + APPOINTMENT_HORIZON_MS).day, [now]);
  const [kind, setKind] = useState<AppointmentKind>(kinds.includes(defaultKind) ? defaultKind : (kinds[0] ?? "meeting"));
  const [day, setDay] = useState(() => firstOpenDay(days, now));
  const [minutes, setMinutes] = useState<AppointmentDuration>(defaultKind === "visit" || defaultKind === "test_drive" ? 30 : 15);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [place, setPlace] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const full = slots.length >= APPOINTMENT_SLOTS_MAX;
  const pickedDays = new Set(slots.map((slot) => moroccoClock(slot.start).day));

  function toggle(start: number) {
    setProblem(null);
    setSlots((current) => {
      if (current.some((slot) => slot.start === start)) return current.filter((slot) => slot.start !== start);
      if (current.length >= APPOINTMENT_SLOTS_MAX) return current;
      return sortSlots([...current, { start, minutes }]);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (slots.length === 0) {
      setProblem(t("pickOne"));
      return;
    }
    const found = slotsProblem(slots, Date.now());
    if (found) {
      setProblem(t(`problems.${found[1]}`));
      return;
    }
    if (/[⟦⟧]/.test(place)) {
      setProblem(t("reserved"));
      return;
    }
    const trimmed = place.trim();
    onSubmit({ kind, slots, ...(trimmed ? { place: trimmed } : {}) });
  }

  const shown = problem ?? error ?? null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6" data-testid="slot-picker">
      {kinds.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t("kind")}</legend>
          <div className="flex flex-wrap gap-2">
            {kinds.map((item) => (
              <label
                key={item}
                className={cn(
                  "inline-flex h-10 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors duration-150 ease-door",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  kind === item ? "border-structure bg-structure text-structure-foreground" : "border-border-strong bg-surface hover:bg-surface-muted",
                )}
              >
                <input type="radio" name={`${id}-kind`} value={item} checked={kind === item} onChange={() => setKind(item)} className="sr-only" />
                {kindLabel(item)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-medium">
          <span>{t("day")}</span>
          <span className="text-xs font-normal text-foreground-muted">{t("timeZone")}</span>
        </legend>
        <div className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pt-1 pb-2 [scrollbar-width:thin]" role="radiogroup" aria-label={t("day")}>
          {days.map((item) => {
            const tile = dayTile(item, locale);
            const selected = day === item;
            const open = GRID_MINUTES.some((value) => moroccoTime(item, value) >= now + APPOINTMENT_LEAD_MS);
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={formatDayKey(item, locale)}
                disabled={!open}
                onClick={() => setDay(item)}
                data-testid="slot-day"
                className={cn(
                  "relative flex w-14 shrink-0 snap-start flex-col items-center gap-0.5 rounded-t-full rounded-b-md border pt-3 pb-2 transition-colors duration-150 ease-door",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  selected ? "border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/30" : "border-border bg-surface hover:border-border-strong hover:bg-surface-muted",
                )}
              >
                <span className={cn("text-[0.6875rem] leading-4", selected ? "text-primary-foreground/85" : "text-foreground-muted")}>{tile.weekday}</span>
                <span className="text-lg leading-6 font-semibold tabular-nums">{tile.date}</span>
                <span className={cn("text-[0.6875rem] leading-4", selected ? "text-primary-foreground/85" : "text-foreground-muted")}>{tile.month}</span>
                {pickedDays.has(item) ? <span aria-hidden="true" className={cn("absolute top-1.5 size-1.5 rounded-full", selected ? "bg-primary-foreground" : "bg-primary")} /> : null}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground-muted">
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{t("otherDay")}</span>
          <input
            type="date"
            min={days[0]}
            max={lastDay}
            value={day}
            onChange={(event) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDay(event.target.value);
            }}
            className={cn(inputClassName, "h-9 w-auto px-2 text-sm")}
          />
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">{t("duration")}</legend>
        <div className="flex flex-wrap gap-1.5">
          {APPOINTMENT_DURATIONS.map((value) => (
            <label
              key={value}
              className={cn(
                "inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm tabular-nums transition-colors duration-150 ease-door",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                minutes === value ? "border-structure bg-structure/10 font-medium text-foreground" : "border-border bg-surface hover:bg-surface-muted",
              )}
            >
              <input type="radio" name={`${id}-duration`} value={value} checked={minutes === value} onChange={() => setMinutes(value)} className="sr-only" />
              {durationLabel(`m${value}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">{t("times", { day: formatDayKey(day, locale) })}</legend>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6" data-testid="slot-times">
          {GRID_MINUTES.map((value) => {
            const start = moroccoTime(day, value);
            const picked = slots.some((slot) => slot.start === start);
            const off = !picked && (full || timeOff(start, minutes, slots, now));
            return (
              <button
                key={value}
                type="button"
                aria-pressed={picked}
                disabled={off}
                onClick={() => toggle(start)}
                className={cn(
                  "h-10 rounded-md border text-sm tabular-nums transition-[background-color,border-color,color,scale] duration-150 ease-door active:scale-[0.97]",
                  "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-muted disabled:text-foreground-muted/60 disabled:line-through",
                  picked ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border bg-surface hover:border-primary/60",
                )}
              >
                {formatSlotClock(start, locale)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <section aria-labelledby={`${id}-picked`} className="flex flex-col gap-2 rounded-lg bg-cream-100/60 p-3 dark:bg-surface-muted">
        <h3 id={`${id}-picked`} className="flex items-baseline justify-between text-sm font-medium">
          <span>{t("picked")}</span>
          <span className="text-xs font-normal text-foreground-muted tabular-nums">{t("count", { count: slots.length, max: APPOINTMENT_SLOTS_MAX })}</span>
        </h3>
        {slots.length === 0 ? (
          <p className="text-sm text-foreground-muted text-pretty">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="slot-picked">
            {slots.map((slot) => (
              <li key={slot.start} className="flex items-center justify-between gap-2 rounded-md bg-surface px-3 py-2 text-sm shadow-xs">
                <span className="min-w-0">
                  <span className="inline-block font-medium first-letter:uppercase">{formatSlotDay(slot.start, locale)}</span>
                  <span className="ms-2 text-foreground-muted tabular-nums">{formatSlotRange(slot, locale)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => toggle(slot.start)}
                  aria-label={t("remove", { time: `${formatSlotDay(slot.start, locale)} ${formatSlotClock(slot.start, locale)}` })}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-surface-muted hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-place`} className="text-sm font-medium">
          {t("place")}
        </label>
        <div className="relative">
          <MapPin className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
          <input
            id={`${id}-place`}
            dir="auto"
            value={place}
            maxLength={APPOINTMENT_PLACE_MAX}
            placeholder={t("placePlaceholder")}
            aria-describedby={`${id}-place-hint`}
            onChange={(event) => {
              setPlace(event.target.value);
              setProblem(null);
            }}
            className={cn(inputClassName, "ps-9")}
          />
        </div>
        <p id={`${id}-place-hint`} className="text-xs text-foreground-muted text-pretty">
          {t("placeHint")}
        </p>
      </div>

      <p className="flex gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-xs text-foreground-muted text-pretty">
        <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
        {t("safety", { site: SITE_NAME })}
      </p>

      {shown ? <InlineError>{shown}</InlineError> : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
        ) : null}
        <Button type="submit" loading={submitting} disabled={slots.length === 0}>
          {t("submit", { count: slots.length })}
        </Button>
      </div>
    </form>
  );
}
