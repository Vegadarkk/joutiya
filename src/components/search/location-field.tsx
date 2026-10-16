"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SEARCH_QUERY_KEYS } from "@/lib/search/params";
import { SearchCityCombobox } from "./city-combobox";
import type { LocationValue } from "./location";

/** Location combobox for a plain GET form (home panel): its choice travels as `ville` or `region`. */
export function LocationField({ initial = {}, inputClassName, className }: { initial?: LocationValue; inputClassName?: string; className?: string }) {
  const t = useTranslations("Search.location");
  const [value, setValue] = useState<LocationValue>(initial);
  return (
    <SearchCityCombobox
      value={value}
      onChange={setValue}
      label={t("label")}
      hideLabel
      names={{ city: SEARCH_QUERY_KEYS.city, region: SEARCH_QUERY_KEYS.region }}
      inputClassName={inputClassName}
      className={className}
    />
  );
}
