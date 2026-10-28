"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CalendarCheck, ImageOff, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cityBySlug, cityName } from "@/config/regions";
import { isRtl, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { usePublicConfig } from "@/lib/config/client";
import type { FleetSaveInput, OwnerListingSummary, RentalAvailability } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import { loadFleet, saveFleet } from "@/lib/listings/client/api";
import { intlLocale } from "@/lib/listings/client/format";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { RENTAL_PERIODS_MAX, blockedSet, isFresh, moroccoToday, periodsOf } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";

// Fleet planning of a car rental agency (rental pack §3, /pro/flotte): its rentals on offer as rows,
// the next 60 days as columns, blocked days drawn as bars like the wall planning of an agency. A tap
// (or Enter) toggles a day, a mouse drag paints a period; the changes of the session are saved at
// once, each vehicle like its own calendar (days past the 60 shown are kept). "Tout est à jour"
// confirms every vehicle shown without changing it. Arrow keys move between days (roving focus).

/** Days shown from today. */
export const FLEET_DAYS = 60;

type Vehicle = OwnerListingSummary & { rental: RentalAvailability };
type Load = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; vehicles: Vehicle[]; truncated: boolean };

const DAY_MS = 86_400_000;
/** 0 = Monday ... 6 = Sunday (1970-01-01 was a Thursday). */
const weekdayIndex = (day: number) => (((day + 3) % 7) + 7) % 7;
const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((day) => b.has(day));

function blockedFrom(rental: RentalAvailability, today: number): Set<number> {
  return new Set([...blockedSet(rental.unavailable)].filter((day) => day >= today));
}

export function FleetPlanning({ now }: { now?: number }) {
  const t = useNumbersTranslations("Fleet");
  const tc = useTranslations("Rental.calendar");
  const locale = useLocale() as Locale;
  const rtl = isRtl(locale);
  const apiMessage = useApiErrorMessage();
  const config = usePublicConfig();
  const [clock] = useState(() => now ?? Date.now());
  const today = moroccoToday(clock);
  const days = useMemo(() => Array.from({ length: FLEET_DAYS }, (_, index) => today + index), [today]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  /** Edited vehicles: their whole blocked set (from today on). */
  const [edits, setEdits] = useState<Map<string, Set<number>>>(() => new Map());
  const [city, setCity] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<"save" | "confirm" | null>(null);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const grid = useRef<HTMLTableElement>(null);
  const paint = useRef<{ id: string; block: boolean } | null>(null);
  const mouseDown = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const fleet = await loadFleet();
      setLoad({ kind: "ready", vehicles: fleet.vehicles.filter((vehicle): vehicle is Vehicle => vehicle.rental !== undefined), truncated: fleet.truncated });
      setEdits(new Map());
    } catch (error) {
      setLoad({ kind: "failed", error });
    }
  }, []);

  useEffect(() => {
    let live = true;
    void loadFleet().then(
      (fleet) => live && setLoad({ kind: "ready", vehicles: fleet.vehicles.filter((vehicle): vehicle is Vehicle => vehicle.rental !== undefined), truncated: fleet.truncated }),
      (error: unknown) => live && setLoad({ kind: "failed", error }),
    );
    const stop = () => {
      paint.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      live = false;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const vehicles = useMemo(() => (load.kind === "ready" ? load.vehicles : []), [load]);
  const saved = useMemo(() => new Map(vehicles.map((vehicle) => [vehicle.id, blockedFrom(vehicle.rental, today)])), [vehicles, today]);
  const cities = useMemo(() => [...new Set(vehicles.map((vehicle) => vehicle.citySlug).filter((slug): slug is string => Boolean(slug)))].map((slug) => ({ slug, name: cityBySlug(slug) ? cityName(cityBySlug(slug)!, locale) : slug })).sort((a, b) => a.name.localeCompare(b.name, intlLocale(locale))), [vehicles, locale]);
  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase(intlLocale(locale));
    return vehicles.filter((vehicle) => (!city || vehicle.citySlug === city) && (!words || vehicle.title.toLocaleLowerCase(intlLocale(locale)).includes(words)));
  }, [vehicles, city, query, locale]);
  const dirty = [...edits.entries()].filter(([id, set]) => !sameSet(set, saved.get(id) ?? new Set()));
  const stale = shown.filter((vehicle) => !isFresh(vehicle.rental.updatedAt ? Date.parse(vehicle.rental.updatedAt) : null, clock)).length;
  const tooMany = dirty.some(([, set]) => periodsOf(set).length > RENTAL_PERIODS_MAX);

  const blockedOf = (id: string) => edits.get(id) ?? saved.get(id) ?? new Set<number>();

  function setDay(id: string, day: number, block: boolean) {
    setEdits((current) => {
      const before = current.get(id) ?? saved.get(id) ?? new Set<number>();
      if (before.has(day) === block) return current;
      const next = new Map(current);
      const set = new Set(before);
      if (block) set.add(day);
      else set.delete(day);
      next.set(id, set);
      return next;
    });
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, id: string, day: number) {
    mouseDown.current = event.pointerType === "mouse";
    if (!mouseDown.current || event.button !== 0) return;
    const block = !blockedOf(id).has(day);
    paint.current = { id, block };
    setDay(id, day, block);
  }

  function onPointerEnter(id: string, day: number) {
    if (paint.current?.id === id) setDay(id, day, paint.current.block);
  }

  function onClick(id: string, day: number, row: number, col: number) {
    setFocus({ row, col });
    // A mouse press already painted this day; a tap or the keyboard toggles it.
    if (mouseDown.current) {
      mouseDown.current = false;
      return;
    }
    setDay(id, day, !blockedOf(id).has(day));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowRight: [0, rtl ? -1 : 1],
      ArrowLeft: [0, rtl ? 1 : -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      Home: [0, -FLEET_DAYS],
      End: [0, FLEET_DAYS],
    };
    const move = moves[event.key];
    if (!move || shown.length === 0) return;
    event.preventDefault();
    const row = Math.min(Math.max(focus.row + move[0], 0), shown.length - 1);
    const col = Math.min(Math.max(focus.col + move[1], 0), FLEET_DAYS - 1);
    setFocus({ row, col });
    grid.current?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus();
  }

  async function send(changes: FleetSaveInput["changes"], mode: "save" | "confirm") {
    setSaving(mode);
    try {
      const { results } = await saveFleet({ changes });
      const failed = results.filter((result) => "error" in result);
      const done = new Map(results.flatMap((result) => ("rental" in result ? [[result.id, result.rental] as const] : [])));
      if (failed.length) {
        toast.error(t("partial", { count: failed.length }));
        await refresh();
        return;
      }
      setLoad((current) => (current.kind === "ready" ? { ...current, vehicles: current.vehicles.map((vehicle) => (done.has(vehicle.id) ? { ...vehicle, rental: done.get(vehicle.id)! } : vehicle)) } : current));
      setEdits(new Map());
      toast.success(mode === "save" ? t("saved", { count: done.size }) : t("confirmed", { count: done.size }));
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setSaving(null);
    }
  }

  function save() {
    void send(
      dirty.map(([id, set]) => ({ id, unavailable: periodsOf(set), since: vehicles.find((vehicle) => vehicle.id === id)?.rental.updatedAt ?? null })),
      "save",
    );
  }

  function confirmAll() {
    void send(
      shown.map((vehicle) => ({ id: vehicle.id, unavailable: vehicle.rental.unavailable, since: vehicle.rental.updatedAt })),
      "confirm",
    );
  }

  if (load.kind === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("loading")}>
        <Skeleton className="h-11 w-full max-w-md" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  if (load.kind === "failed") {
    return (
      <FormMessage error={load.error} scope="listing">
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>
          {t("retry")}
        </Button>
      </FormMessage>
    );
  }
  if (vehicles.length === 0) {
    return (
      <EmptyState
        title={t("emptyTitle")}
        action={
          <Button asChild>
            <Link href="/deposer">{t("emptyAction")}</Link>
          </Button>
        }
      >
        {t("emptyBody")}
      </EmptyState>
    );
  }

  const tag = intlLocale(locale);
  const monthFormat = new Intl.DateTimeFormat(tag, { month: "long", timeZone: "UTC" });
  const weekdayFormat = new Intl.DateTimeFormat(tag, { weekday: "narrow", timeZone: "UTC" });
  const dayFormat = new Intl.DateTimeFormat(tag, { day: "numeric", timeZone: "UTC" });
  const fullFormat = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const months: { start: number; span: number }[] = [];
  for (const day of days) {
    const last = months[months.length - 1];
    if (last && new Date(day * DAY_MS).getUTCDate() !== 1) last.span += 1;
    else months.push({ start: day, span: 1 });
  }
  const mediaBaseUrl = config?.mediaBaseUrl ?? null;
  const focusRow = Math.min(focus.row, Math.max(shown.length - 1, 0));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2 sm:grid-cols-[12rem_16rem]">
          <label className="flex flex-col gap-1 text-xs text-foreground-muted">
            {t("city")}
            <select className={cn(inputClassName, "h-11")} value={city} onChange={(event) => setCity(event.target.value)}>
              <option value="">{t("allCities")}</option>
              {cities.map((each) => (
                <option key={each.slug} value={each.slug}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-muted">
            {t("search")}
            <span className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
              <input type="search" className={cn(inputClassName, "h-11 ps-9")} value={query} onChange={(event) => setQuery(event.target.value)} />
            </span>
          </label>
        </div>
        <Button type="button" variant="outline" loading={saving === "confirm"} disabled={saving !== null || dirty.length > 0 || shown.length === 0} onClick={confirmAll} data-testid="fleet-confirm">
          <CalendarCheck aria-hidden="true" />
          {t("confirm")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
        <p data-testid="fleet-summary" className={cn(stale > 0 ? "font-medium text-warning" : "text-foreground-muted")}>
          {t("vehicles", { count: shown.length })} {stale > 0 ? t("stale", { count: stale }) : t("allFresh")}
        </p>
        <ul className="flex items-center gap-4 text-xs text-foreground-muted" aria-label={t("legend")}>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-5 rounded-sm border border-border bg-surface" />
            {tc("legendFree")}
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-5 rounded-sm bg-danger" />
            {tc("legendBlocked")}
          </li>
        </ul>
      </div>

      {load.truncated ? <p className="text-sm text-warning">{t("truncated")}</p> : null}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-foreground-muted">{t("noMatch")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" data-testid="fleet-grid">
          <table ref={grid} role="grid" aria-label={t("gridLabel")} aria-rowcount={shown.length + 2} className="border-separate border-spacing-0 text-sm select-none" onKeyDown={onKeyDown}>
            <thead>
              <tr>
                <th rowSpan={2} scope="col" className="sticky start-0 z-20 w-40 min-w-40 border-e border-b border-border bg-surface px-3 text-start text-xs font-medium text-foreground-muted sm:w-64 sm:min-w-64">
                  {t("vehicle")}
                </th>
                {months.map((month) => (
                  <th key={month.start} colSpan={month.span} scope="colgroup" className="h-8 border-b border-border px-2 text-start text-xs font-semibold capitalize">
                    <span className="sticky start-44 sm:start-68">{monthFormat.format(new Date(month.start * DAY_MS))}</span>
                  </th>
                ))}
              </tr>
              <tr>
                {days.map((day) => {
                  const weekend = weekdayIndex(day) >= 5;
                  return (
                    <th key={day} scope="col" abbr={fullFormat.format(new Date(day * DAY_MS))} className={cn("h-11 w-9 min-w-9 border-b border-border text-center align-middle font-normal", weekend && "bg-surface-brand/60", day === today && "bg-structure text-structure-foreground")}>
                      <span className="flex flex-col items-center leading-tight">
                        <span className="text-[0.65rem] uppercase opacity-80">{weekdayFormat.format(new Date(day * DAY_MS))}</span>
                        <span className="text-xs font-semibold tabular-nums">{dayFormat.format(new Date(day * DAY_MS))}</span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((vehicle, row) => {
                const blocked = blockedOf(vehicle.id);
                const edited = dirty.some(([id]) => id === vehicle.id);
                const fresh = isFresh(vehicle.rental.updatedAt ? Date.parse(vehicle.rental.updatedAt) : null, clock);
                const place = vehicle.citySlug ? cityBySlug(vehicle.citySlug) : undefined;
                const thumb = vehicle.thumb ? photoUrl(mediaBaseUrl, vehicle.id, vehicle.thumb.id, "s") : null;
                return (
                  <tr key={vehicle.id} data-testid="fleet-row" data-vehicle={vehicle.id}>
                    <th scope="row" className={cn("sticky start-0 z-10 border-e border-b border-border bg-surface px-3 py-2 text-start font-normal", edited && "bg-surface-brand")}>
                      <span className="flex items-center gap-2.5">
                        <span className="relative hidden size-10 shrink-0 overflow-hidden rounded-md bg-surface-brand sm:block">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumb} alt="" width={40} height={40} loading="lazy" decoding="async" className="size-full object-cover" />
                          ) : (
                            <ImageOff aria-hidden="true" className="m-auto mt-3 size-4 text-foreground-muted" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="line-clamp-2 text-sm font-medium" title={vehicle.title}>
                            {vehicle.title}
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
                            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", fresh ? "bg-success" : "bg-warning")} />
                            <span className="truncate">{[place ? cityName(place, locale) : null, edited ? t("edited") : fresh ? t("fresh") : t("toConfirm")].filter(Boolean).join(", ")}</span>
                          </span>
                        </span>
                      </span>
                    </th>
                    {days.map((day, col) => {
                      const isBlocked = blocked.has(day);
                      const starts = isBlocked && !blocked.has(day - 1);
                      const ends = isBlocked && !blocked.has(day + 1);
                      const weekend = weekdayIndex(day) >= 5;
                      return (
                        <td key={day} role="gridcell" className={cn("h-14 border-b border-border p-0", weekend && "bg-surface-brand/40", day === today && "bg-structure/5")}>
                          <button
                            type="button"
                            tabIndex={row === focusRow && col === focus.col ? 0 : -1}
                            data-row={row}
                            data-col={col}
                            data-day={new Date(day * DAY_MS).toISOString().slice(0, 10)}
                            data-state={isBlocked ? "blocked" : "free"}
                            aria-pressed={isBlocked}
                            aria-label={`${isolate(vehicle.title)}, ${fullFormat.format(new Date(day * DAY_MS))} : ${isBlocked ? tc("blocked") : tc("free")}`}
                            className="group relative flex size-full cursor-pointer items-center outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            onPointerDown={(event) => onPointerDown(event, vehicle.id, day)}
                            onPointerEnter={() => onPointerEnter(vehicle.id, day)}
                            onClick={() => onClick(vehicle.id, day, row, col)}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                "h-6 w-full transition-colors",
                                isBlocked ? "bg-danger group-hover:bg-danger/85" : "group-hover:bg-border/60",
                                starts && "ms-1 rounded-s-full",
                                ends && "me-1 rounded-e-full",
                                !isBlocked && "mx-1 rounded-full",
                              )}
                            />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dirty.length > 0 ? (
        <div className="sticky bottom-4 z-30 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg shadow-bab-950/10 sm:flex-row sm:items-center sm:justify-between" data-testid="fleet-savebar">
          <p role="status" className="text-sm font-medium">
            {tooMany ? <span className="text-danger">{t("tooMany", { max: RENTAL_PERIODS_MAX })}</span> : t("pending", { count: dirty.length })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={saving !== null} onClick={() => setEdits(new Map())}>
              {t("cancel")}
            </Button>
            <Button type="button" loading={saving === "save"} disabled={saving !== null || tooMany} onClick={save}>
              {t("save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
