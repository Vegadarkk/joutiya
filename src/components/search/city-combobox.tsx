"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Map as MapIcon, MapPin, MapPinned, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { inputClassName } from "@/components/ui/input";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { cn } from "@/lib/utils";
import { committedOption, isSelected, locationName, locationOptions, optionKey, optionValue, regionOfCity, type LocationOption, type LocationValue } from "./location";

// Location field of the search (design D7, D21): the phase 3 city picker in its "any city"
// variant. One input over the whole country, the 12 regions and ~100 cities; empty means the whole
// country. ARIA combobox + listbox; Enter picks the highlighted option only after the person moved
// through the list or typed, so Enter right after focusing still submits the form. In a GET form
// the choice travels as a hidden `ville` or `region` input (the typed text is never submitted:
// leaving the field commits its highlighted or first option).

interface SearchCityComboboxProps {
  value: LocationValue;
  onChange: (value: LocationValue) => void;
  label: string;
  /** Label for screen readers only (compact bars). */
  hideLabel?: boolean;
  /** Hidden inputs of a GET form: `{ city: "ville", region: "region" }`. */
  names?: { city: string; region: string };
  /** List in the page flow (filters sheet) instead of floating over it. */
  inline?: boolean;
  /** Overrides the hook (unit tests). */
  locale?: Locale;
  className?: string;
  inputClassName?: string;
}

function OptionIcon({ option }: { option: LocationOption }) {
  const Icon = option.kind === "all" ? MapIcon : option.kind === "region" ? MapPinned : MapPin;
  return <Icon className="size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />;
}

export function SearchCityCombobox({ value, onChange, label, hideLabel, names, inline, locale: localeProp, className, inputClassName: inputClass }: SearchCityComboboxProps) {
  const t = useTranslations("Search.location");
  const hookLocale = useLocale() as Locale;
  const locale = localeProp ?? hookLocale;
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);
  // null: not typing, the input shows the chosen place.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted (Enter submits the form).
  const [active, setActive] = useState(-1);

  const name = locationName(value, locale) ?? "";
  const options = useMemo(() => locationOptions(query ?? "", locale), [query, locale]);

  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  function choose(option: LocationOption) {
    onChange(optionValue(option));
    setQuery(null);
    setOpen(false);
    setActive(-1);
  }

  function primary(option: LocationOption): string {
    if (option.kind === "all") return t("all");
    if (option.kind === "region") {
      const region = regionByCode(option.code);
      return region ? regionName(region, locale) : option.code;
    }
    const city = cityBySlug(option.slug);
    return city ? cityName(city, locale) : option.slug;
  }

  function secondary(option: LocationOption): string | null {
    if (option.kind === "region") return t("wholeRegion");
    if (option.kind === "city") return regionOfCity(option.slug, locale);
    return null;
  }

  const activeOption = open && active >= 0 ? options[active] : undefined;
  const hasValue = Boolean(value.city || value.region);

  return (
    <div className={cn("relative flex flex-col gap-1.5", className)}>
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-sm font-medium text-foreground"}>
        {label}
      </label>
      <div className="relative">
        <MapPin className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
        <input
          ref={input}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? `${listId}-${optionKey(activeOption)}` : undefined}
          placeholder={t("all")}
          value={query ?? name}
          className={cn(inputClassName, "ps-9", hasValue && "pe-11", inputClass)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(event.target.value.trim() ? 0 : -1);
            setOpen(true);
          }}
          onFocus={(event) => {
            window.clearTimeout(blurTimer.current);
            event.currentTarget.select();
            setOpen(true);
          }}
          onBlur={() => {
            // Typed text counts without a pick (Tab, or a click on "Rechercher": blur is a discrete
            // event, so the form submits after this re-render with the new place).
            const option = committedOption(query, options, active);
            if (option) choose(option);
            blurTimer.current = window.setTimeout(() => {
              if (document.activeElement === input.current) return;
              setOpen(false);
              setQuery(null);
              setActive(-1);
            }, 120);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.min(options.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              if (activeOption) {
                event.preventDefault();
                choose(activeOption);
              }
            } else if (event.key === "Escape") {
              if (open) event.preventDefault();
              setOpen(false);
              setQuery(null);
              setActive(-1);
            }
          }}
        />
        {hasValue ? (
          <button
            type="button"
            aria-label={t("clear")}
            onClick={() => {
              onChange({});
              setQuery(null);
              input.current?.focus();
            }}
            className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-md text-foreground-muted transition-colors duration-150 ease-door hover:text-foreground focus-visible:-outline-offset-2"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        id={listId}
        role="listbox"
        // Scrolling makes it focusable: Tab goes on to the next field, and a click in the list or on
        // its scrollbar keeps the focus (and the typed text) in the input.
        tabIndex={-1}
        aria-label={t("results")}
        onMouseDown={(event) => event.preventDefault()}
        className={cn(
          "flex max-h-80 flex-col overflow-y-auto rounded-md border border-border bg-surface py-1 text-foreground shadow-lg shadow-bab-950/10",
          // Above the sticky results toolbar (z-30), under the sticky header (z-40).
          !inline && "absolute inset-x-0 top-full z-35 mt-1",
          !open && "hidden",
        )}
      >
        {options.length === 0 ? (
          <p className="px-4 py-3 text-sm text-foreground-muted">{t("noMatch", { query: query ?? "" })}</p>
        ) : (
          options.map((option, index) => {
            const selected = isSelected(option, value);
            const detail = secondary(option);
            return (
              <div
                key={optionKey(option)}
                id={`${listId}-${optionKey(option)}`}
                role="option"
                aria-selected={selected}
                data-active={index === active || undefined}
                onClick={() => choose(option)}
                onMouseEnter={() => setActive(index)}
                className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 data-[active]:bg-surface-muted"
              >
                <OptionIcon option={option} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate", option.kind !== "city" && "font-medium")}>{primary(option)}</span>
                  {detail ? <span className="truncate text-xs text-foreground-muted">{detail}</span> : null}
                </span>
                {selected ? <Check className="size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" /> : null}
              </div>
            );
          })
        )}
      </div>
      {names && value.city ? <input type="hidden" name={names.city} value={value.city} /> : null}
      {names && !value.city && value.region ? <input type="hidden" name={names.region} value={value.region} /> : null}
    </div>
  );
}
