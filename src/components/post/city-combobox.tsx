"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, MapPin, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cityName, regionByCode, regionName, searchCities, type City } from "@/config/regions";
import type { Locale } from "@/config/site";
import { cn } from "@/lib/utils";

// Step 7: one input over the ~100 cities (src/config/regions.ts): accent- and script-insensitive,
// results grouped by region in rank order, major cities first when the box is empty. ARIA
// combobox + listbox; the chosen city is shown with its region and a "Changer" button.

interface CityComboboxProps {
  value: City | null;
  onSelect: (city: City) => void;
  error?: string;
  required?: boolean;
  /** Overrides the hook (unit tests). */
  locale?: Locale;
  /** Start in search mode (no city yet, or the person asked to change). */
  autoFocus?: boolean;
}

interface Group {
  code: string;
  name: string;
  cities: City[];
}

export function groupByRegion(cities: readonly City[], locale: Locale): Group[] {
  const groups: Group[] = [];
  for (const city of cities) {
    let group = groups.find((g) => g.code === city.regionCode);
    if (!group) {
      const region = regionByCode(city.regionCode);
      group = { code: city.regionCode, name: region ? regionName(region, locale) : city.regionCode, cities: [] };
      groups.push(group);
    }
    group.cities.push(city);
  }
  return groups;
}

export function CityCombobox({ value, onSelect, error, required, locale: localeProp, autoFocus }: CityComboboxProps) {
  const t = useTranslations("Listing.fields");
  const hookLocale = useLocale() as Locale;
  const locale = localeProp ?? hookLocale;
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const [editing, setEditing] = useState(value === null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchCities(query, locale, 12), [query, locale]);
  const groups = useMemo(() => groupByRegion(results, locale), [results, locale]);
  // Keyboard order follows the rendered (grouped) order, not the raw ranking.
  const flat = useMemo(() => groups.flatMap((group) => group.cities), [groups]);

  useEffect(() => {
    if (editing && autoFocus) input.current?.focus();
  }, [editing, autoFocus]);

  function choose(city: City) {
    onSelect(city);
    setQuery("");
    setOpen(false);
    setEditing(false);
  }

  if (!editing && value) {
    const region = regionByCode(value.regionCode);
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">
          {t("city")}
          {required ? (
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border-strong bg-surface-brand px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <MapPin className="size-5 shrink-0 text-structure" aria-hidden="true" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{cityName(value, locale)}</span>
              <span className="truncate text-sm text-foreground-muted">{region ? regionName(region, locale) : value.regionCode}</span>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
              setOpen(true);
            }}
            className="shrink-0 max-sm:h-11"
          >
            {t("changeCity")}
          </Button>
        </div>
        <p className="sr-only">{t("cityChosen", { city: cityName(value, locale), region: region ? regionName(region, locale) : "" })}</p>
      </div>
    );
  }

  let position = 0;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {t("city")}
        {required ? (
          <span className="ms-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
        <Input
          ref={input}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && flat[active] ? `${listId}-${flat[active].slug}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-required={required || undefined}
          placeholder={t("cityPlaceholder")}
          value={query}
          className="ps-10"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.min(flat.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              const city = flat[active];
              if (open && city) {
                event.preventDefault();
                choose(city);
              }
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      <div id={listId} role="listbox" aria-label={query ? t("cityResults") : t("majorCities")} className={cn("flex max-h-72 flex-col overflow-y-auto rounded-md border border-border bg-surface shadow-lg shadow-bab-950/10", !open && "hidden")}>
        {groups.length === 0 ? (
          <p className="px-4 py-3 text-sm text-foreground-muted">{t("noCity", { query })}</p>
        ) : (
          groups.map((group) => (
            <div key={group.code} role="group" aria-labelledby={`${listId}-g${group.code}`}>
              <p id={`${listId}-g${group.code}`} className="sticky top-0 bg-surface-muted px-4 py-1.5 text-xs font-medium text-foreground-muted">
                {group.name}
              </p>
              {group.cities.map((city) => {
                const index = position++;
                const selected = value?.slug === city.slug;
                return (
                  <div
                    key={city.slug}
                    id={`${listId}-${city.slug}`}
                    role="option"
                    aria-selected={selected}
                    data-active={index === active || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(city)}
                    onMouseEnter={() => setActive(index)}
                    className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-2.5 data-[active]:bg-surface-muted"
                  >
                    <span className={cn(city.major && "font-medium")}>{cityName(city, locale)}</span>
                    {selected ? <Check className="size-4 text-structure" aria-hidden="true" /> : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {error ? <InlineError id={errorId}>{error}</InlineError> : null}
    </div>
  );
}
