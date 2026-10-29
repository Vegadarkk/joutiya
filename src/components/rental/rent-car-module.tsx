"use client";

import { useEffect, useRef, useState } from "react";
import { CarFront, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { dropEmptyFields } from "@/components/search/drop-empty-fields";
import { LocationField } from "@/components/search/location-field";
import { Button } from "@/components/ui/button";
import { RENTAL_SUBCATEGORY } from "@/config/categories";
import { SEARCH_PATH, SEARCH_QUERY_KEYS, type RentalDates } from "@/lib/search/params";
import { RentalDatesFields } from "./rental-dates-fields";

// Home "Louer une voiture" module (rental pack §4): a city and the rental days lead to the car
// rental search by dates. A GET form, so it works before hydration; empty fields are left out.

function onFormData(event: FormDataEvent) {
  dropEmptyFields(event.formData);
}

export function RentCarModule({ locale }: { locale: string }) {
  const t = useTranslations("Rental.home");
  const form = useRef<HTMLFormElement>(null);
  const [dates, setDates] = useState<Partial<RentalDates>>({});

  useEffect(() => {
    const element = form.current;
    element?.addEventListener("formdata", onFormData);
    return () => element?.removeEventListener("formdata", onFormData);
  }, []);

  return (
    <section aria-labelledby="home-rent-car" data-testid="home-rent-car" className="flex flex-col gap-4 rounded-lg border border-border bg-surface-brand p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-structure text-structure-foreground">
          <CarFront aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h2 id="home-rent-car" className="text-xl font-semibold">
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-foreground-muted text-pretty">{t("body")}</p>
        </div>
      </div>
      <form ref={form} action={`/${locale}${SEARCH_PATH}`} method="get" className="grid gap-2 lg:grid-cols-[1fr_1.4fr_auto] lg:items-end">
        <input type="hidden" name={SEARCH_QUERY_KEYS.category} value="vehicules" />
        <input type="hidden" name={SEARCH_QUERY_KEYS.subcategory} value={RENTAL_SUBCATEGORY} />
        <LocationField inputClassName="h-12" />
        <RentalDatesFields value={dates} onChange={setDates} names={{ from: SEARCH_QUERY_KEYS.rentFrom, to: SEARCH_QUERY_KEYS.rentTo }} inputClassName="h-12" />
        <Button type="submit" size="lg" className="h-12">
          <Search aria-hidden="true" />
          {t("submit")}
        </Button>
      </form>
    </section>
  );
}
