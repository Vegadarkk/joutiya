"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

// Labels of the category tree and of the criteria (ids come from src/config/categories.ts and are
// plain strings, so the typed message keys need one cast, kept here). A missing key shows the id.

export function useCategoryLabels(): { category: (categoryId: string) => string; subcategory: (categoryId: string, subcategoryId: string) => string } {
  const t = useTranslations("Categories");
  type Key = Parameters<typeof t.has>[0];
  return {
    category: useCallback((categoryId: string) => (t.has(`${categoryId}.name` as Key) ? t(`${categoryId}.name` as Key) : categoryId), [t]),
    subcategory: useCallback((categoryId: string, subcategoryId: string) => (t.has(`${categoryId}.sub.${subcategoryId}` as Key) ? t(`${categoryId}.sub.${subcategoryId}` as Key) : subcategoryId), [t]),
  };
}

export function useCriteriaLabels(): { label: (criterionId: string) => string; option: (criterionId: string, optionId: string) => string } {
  const t = useTranslations("Criteria");
  type Key = Parameters<typeof t.has>[0];
  return {
    label: useCallback((criterionId: string) => (t.has(`${criterionId}.label` as Key) ? t(`${criterionId}.label` as Key) : criterionId), [t]),
    option: useCallback((criterionId: string, optionId: string) => (t.has(`${criterionId}.options.${optionId}` as Key) ? t(`${criterionId}.options.${optionId}` as Key) : optionId), [t]),
  };
}
