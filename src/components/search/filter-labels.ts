import { useLocale, useTranslations } from "next-intl";
import type { Condition, CriterionUnit } from "@/config/categories";
import type { FilterLabels } from "./filter-model";

// next-intl translators -> FilterLabels (filter-model.ts). Ids come from src/config/categories.ts
// as plain strings, so the typed message keys need one loose signature, kept here. No "use client":
// server components (chips, empty state) and client islands (sheet) both call the hook.

/** The part of a next-intl translator the labels use. */
export interface LooseTranslator {
  (key: string, values?: Record<string, string>): string;
  has(key: string): boolean;
}

export interface LabelTranslators {
  chips: LooseTranslator;
  categories: LooseTranslator;
  criteria: LooseTranslator;
  units: LooseTranslator;
}

export function makeFilterLabels({ chips, categories, criteria, units }: LabelTranslators, locale: string): FilterLabels {
  const lookup = (t: LooseTranslator, key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
  return {
    category: (id) => lookup(categories, `${id}.name`, id),
    subcategory: (categoryId, id) => lookup(categories, `${categoryId}.sub.${id}`, id),
    criterion: (id) => lookup(criteria, `${id}.label`, id),
    option: (criterionId, optionId) => lookup(criteria, `${criterionId}.options.${optionId}`, optionId),
    condition: (value: Condition) => lookup(criteria, `condition.options.${value}`, value),
    unit: (unit: CriterionUnit) => lookup(units, unit, unit),
    chip: (key, values) => chips(key, values),
    separator: locale === "ar" ? "، " : ", ",
  };
}

export function useFilterLabels(): FilterLabels {
  const locale = useLocale();
  const chips = useTranslations("SearchFilters.chips");
  const categories = useTranslations("Categories");
  const criteria = useTranslations("Criteria");
  const units = useTranslations("Listing.units");
  return makeFilterLabels(
    {
      chips: chips as unknown as LooseTranslator,
      categories: categories as unknown as LooseTranslator,
      criteria: criteria as unknown as LooseTranslator,
      units: units as unknown as LooseTranslator,
    },
    locale,
  );
}
