"use client";

import { useEffect, useRef, useState } from "react";
import { CarFront, Search, TreePalm } from "lucide-react";
import { useTranslations } from "next-intl";
import { dropEmptyFields } from "@/components/search/drop-empty-fields";
import { LocationField } from "@/components/search/location-field";
import { Button } from "@/components/ui/button";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { SEARCH_PATH, SEARCH_QUERY_KEYS, type RentalDates } from "@/lib/search/params";
import { RentalDatesFields } from "./rental-dates-fields";

const HOLIDAY_SUBCATEGORY = "location-vacances";

// Home "Louer une voiture" module (rental pack §4): a city and the rental days lead to the car
// rental search by dates. A GET form, so it works before hydration; empty fields are left out.
// Two tabs share the box (owner, 2026-10-31): the car and the holiday rental, priced per night,
// whose dates read arrival and departure.

function onFormData(event: FormDataEvent) {
  dropEmptyFields(event.formData);
}

export function RentCarModule({ locale }: { locale: string }) {
  const t = useTranslations("Rental.home");
  const form = useRef<HTMLFormElement>(null);
  const [dates, setDates] = useState<Partial<RentalDates>>({});
  const [kind, setKind] = useState<"car" | "holiday">("car");
  const holiday = kind === "holiday";
  const Icon = holiday ? TreePalm : CarFront;

  useEffect(() => {
    const element = form.current;
    element?.addEventListener("formdata", onFormData);
    return () => element?.removeEventListener("formdata", onFormData);
  }, []);

  return (
    <section aria-labelledby="home-rent-car" data-testid="home-rent-car" className="flex flex-col gap-4 rounded-lg border border-border bg-surface-brand p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-structure text-structure-foreground">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="home-rent-car" className="text-xl font-semibold">
            {t(holiday ? "holidayTitle" : "title")}
          </h2>
          <p className="mt-1 text-sm text-foreground-muted text-pretty">{t(holiday ? "holidayBody" : "body")}</p>
        </div>
        <div role="group" aria-label={t("kind")} className="flex shrink-0 rounded-full border border-border-strong bg-surface p-0.5 text-sm max-sm:hidden">
          {(["car", "holiday"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              data-testid={`home-rent-${option}`}
              onClick={() => {
                setKind(option);
                setDates({});
              }}
              className="rounded-full px-3 py-1.5 font-medium text-foreground-muted transition-colors duration-150 ease-door aria-pressed:bg-structure aria-pressed:text-structure-foreground"
            >
              {t(option === "car" ? "tabCar" : "tabHoliday")}
            </button>
          ))}
        </div>
      </div>
      <div role="group" aria-label={t("kind")} className="grid grid-cols-2 rounded-full border border-border-strong bg-surface p-0.5 text-sm sm:hidden">
        {(["car", "holiday"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => {
              setKind(option);
              setDates({});
            }}
            className="rounded-full px-3 py-2 font-medium text-foreground-muted aria-pressed:bg-structure aria-pressed:text-structure-foreground"
          >
            {t(option === "car" ? "tabCar" : "tabHoliday")}
          </button>
        ))}
      </div>
      <form ref={form} action={`/${locale}${SEARCH_PATH}`} method="get" className="grid gap-2 lg:grid-cols-[1fr_1.4fr_auto] lg:items-end">
        <input type="hidden" name={SEARCH_QUERY_KEYS.category} value={holiday ? "immobilier" : "vehicules"} />
        <input type="hidden" name={SEARCH_QUERY_KEYS.subcategory} value={holiday ? HOLIDAY_SUBCATEGORY : RENTAL_SUBCATEGORY} />
        <LocationField inputClassName="h-12" />
        <RentalDatesFields value={dates} onChange={setDates} names={{ from: SEARCH_QUERY_KEYS.rentFrom, to: SEARCH_QUERY_KEYS.rentTo }} inputClassName="h-12" unit={holiday ? "night" : "day"} />
        <Button type="submit" size="lg" className="h-12">
          <Search aria-hidden="true" />
          {t(holiday ? "holidaySubmit" : "submit")}
        </Button>
      </form>
    </section>
  );
}
