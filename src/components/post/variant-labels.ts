"use client";

import { useCallback } from "react";
import { isVariantCriterion, type VariantAxis } from "@/lib/contracts/catalog";
import { keyValues } from "@/lib/listings/client/variants";
import { useCriteriaLabels } from "./labels";

/**
 * Names of a variant combination (« M / Bleu », « 500 g »): a criterion axis shows its translated
 * option, a free axis the value as the Pro typed it.
 */
export function useVariantLabels(): { value: (axis: Pick<VariantAxis, "id">, value: string) => string; combination: (axes: readonly Pick<VariantAxis, "id">[], key: string) => string } {
  const criteria = useCriteriaLabels();
  const value = useCallback((axis: Pick<VariantAxis, "id">, raw: string) => (isVariantCriterion(axis.id) ? criteria.option(axis.id, raw) : raw), [criteria]);
  const combination = useCallback(
    (axes: readonly Pick<VariantAxis, "id">[], key: string) =>
      keyValues(key)
        .map((raw, index) => {
          const axis = axes[index];
          return axis ? value(axis, raw) : raw;
        })
        .join(" / "),
    [value],
  );
  return { value, combination };
}
