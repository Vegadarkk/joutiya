"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { SearchCityCombobox } from "@/components/search/city-combobox";
import { dropEmptyFields } from "@/components/search/drop-empty-fields";
import type { LocationValue } from "@/components/search/location";
import { SEARCH_PATH, SEARCH_Q_MAX, SEARCH_QUERY_KEYS } from "@/lib/search/url-keys";
import { cn } from "@/lib/utils";

// The header's search pill (Carte vivante, lot 1): words, then the place from lg (the search page's
// own combobox in its "any city" variant), then the ochre submit. A GET form to /recherche that
// works before hydration: `q`, and `ville` (slug) or `region`; empty fields leave the URL once
// hydrated. Phones keep the words only: the place is set on the search page.

function onFormData(event: FormDataEvent) {
  dropEmptyFields(event.formData);
}

/** A segment of the pill: borderless, tinted while it holds the focus. */
const SEGMENT_INPUT = cn(
  "h-11 w-full min-w-0 rounded-full border-0 bg-transparent text-base text-ellipsis text-foreground placeholder:text-foreground-muted md:text-[0.9375rem]",
  "transition-[background-color] duration-150 ease-door focus-visible:bg-surface-muted focus-visible:outline-none",
);

export function HeaderSearch({ locale, className }: { locale: string; className?: string }) {
  const t = useTranslations("Nav");
  const form = useRef<HTMLFormElement>(null);
  const [place, setPlace] = useState<LocationValue>({});

  useEffect(() => {
    const element = form.current;
    element?.addEventListener("formdata", onFormData);
    return () => element?.removeEventListener("formdata", onFormData);
  }, []);

  return (
    <form
      ref={form}
      action={`/${locale}${SEARCH_PATH}`}
      method="get"
      role="search"
      aria-label={t("searchLabel")}
      className={cn(
        "float-card flex h-12 min-w-0 items-center gap-1 rounded-full p-0.5 md:h-13 md:p-1",
        "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
        className,
      )}
    >
      <div className="relative min-w-0 flex-1">
        <label htmlFor="header-search" className="sr-only">
          {t("searchLabel")}
        </label>
        {/* Phones: the submit's magnifier is enough, the words get the room. */}
        <Search className="pointer-events-none absolute start-3.5 top-1/2 hidden size-[1.125rem] -translate-y-1/2 text-foreground-muted md:block" aria-hidden="true" />
        <input
          id="header-search"
          name={SEARCH_QUERY_KEYS.q}
          type="search"
          enterKeyHint="search"
          maxLength={SEARCH_Q_MAX}
          placeholder={t("searchPlaceholder")}
          className={cn(SEGMENT_INPUT, "ps-4 pe-2 md:ps-10 [&::-webkit-search-cancel-button]:hidden")}
        />
      </div>
      <div className="relative hidden w-52 shrink-0 before:absolute before:start-0 before:top-1/2 before:h-6 before:w-px before:-translate-y-1/2 before:bg-border-strong lg:block xl:w-60">
        <SearchCityCombobox
          value={place}
          onChange={setPlace}
          label={t("searchPlace")}
          hideLabel
          names={{ city: SEARCH_QUERY_KEYS.city, region: SEARCH_QUERY_KEYS.region }}
          className="gap-0 ps-1.5"
          inputClassName={cn(SEGMENT_INPUT, "focus-visible:ring-0")}
        />
      </div>
      <button
        type="submit"
        aria-label={t("searchSubmit")}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,scale] duration-150 ease-door hover:bg-primary-hover active:scale-95"
      >
        <Search className="size-[1.125rem]" strokeWidth={2.25} aria-hidden="true" />
      </button>
    </form>
  );
}
