import type { Subcategory } from "@/config/categories";
import {
  FREE_AXES,
  VARIANT_AXES_MAX,
  VARIANT_ITEMS_MAX,
  VARIANT_VALUE_MAX,
  VARIANT_KEY_SEPARATOR,
  isVariantCriterion,
  listingVariantsSchema,
  variantCombinations,
  type FreeAxis,
  type ListingVariants,
  type VariantAxis,
  type VariantAxisId,
  type VariantItem,
} from "@/lib/contracts/catalog";
import type { ListingAttributes } from "@/lib/contracts/listings";

// Editing state of the variants block of the wizard (catalogue §2): the axes as the Pro builds
// them, the combinations kept in step (a new value adds its combinations, a combination the Pro
// unticked stays out), and the patch the API takes. Pure and client-safe, unit-tested.

/** Axes the subcategory offers: its criteria a variant may take over, then the free ones. */
export function axisChoices(subcategory: Pick<Subcategory, "criteria"> | undefined): VariantAxisId[] {
  const criteria = (subcategory?.criteria ?? []).map((criterion) => criterion.id).filter(isVariantCriterion);
  return [...criteria, ...FREE_AXES];
}

/** A free axis id not used yet (two free axes at most). */
export function nextFreeAxis(axes: readonly Pick<VariantAxis, "id">[]): FreeAxis | undefined {
  return FREE_AXES.find((id) => !axes.some((axis) => axis.id === id));
}

/** Axes still to choose for a new axis, in offer order. */
export function remainingAxes(subcategory: Pick<Subcategory, "criteria"> | undefined, axes: readonly Pick<VariantAxis, "id">[]): VariantAxisId[] {
  if (axes.length >= VARIANT_AXES_MAX) return [];
  return axisChoices(subcategory).filter((id) => !axes.some((axis) => axis.id === id));
}

/**
 * The combinations after an edit of the axes: those the listing had keep their stock, price and
 * reference; a combination that did not exist before is offered (ticked); one the Pro had unticked
 * stays out. Capped at VARIANT_ITEMS_MAX in combination order.
 */
export function rebuildItems(before: readonly Pick<VariantAxis, "values">[], after: readonly Pick<VariantAxis, "values">[], items: readonly VariantItem[]): VariantItem[] {
  const previous = new Set(variantCombinations(before));
  const kept = new Map(items.map((item) => [item.key, item]));
  return variantCombinations(after)
    .filter((key) => kept.has(key) || !previous.has(key))
    .map((key) => kept.get(key) ?? { key })
    .slice(0, VARIANT_ITEMS_MAX);
}

/** Number of combinations the axes make (shown when it passes the cap). */
export function combinationCount(axes: readonly Pick<VariantAxis, "values">[]): number {
  return axes.length === 0 ? 0 : axes.reduce((count, axis) => count * axis.values.length, 1);
}

/** Values of a combination key, axis order. */
export const keyValues = (key: string): string[] => key.split(VARIANT_KEY_SEPARATOR);

/** A typed free value, trimmed and cut to the contract's bound; "" when nothing usable is left. */
export function cleanValue(value: string): string {
  return value.replaceAll(VARIANT_KEY_SEPARATOR, " ").replace(/\s+/g, " ").trim().slice(0, VARIANT_VALUE_MAX).trim();
}

/** Whether `values` already holds `value` (case and spaces ignored, as the contract compares). */
export function hasValue(values: readonly string[], value: string): boolean {
  const wanted = value.trim().toLowerCase();
  return values.some((existing) => existing.trim().toLowerCase() === wanted);
}

/** The variants as the API stores them, or null when they are not complete yet (the save waits). */
export function variantsPatch(axes: readonly VariantAxis[], items: readonly VariantItem[]): ListingVariants | null {
  const parsed = listingVariantsSchema.safeParse({ axes, items });
  return parsed.success ? parsed.data : null;
}

/** The attributes without the criteria the axes take over (the server drops them too). */
export function attributesWithoutAxes(attributes: ListingAttributes, axes: readonly Pick<VariantAxis, "id">[]): ListingAttributes {
  const taken = new Set<string>(axes.map((axis) => axis.id).filter(isVariantCriterion));
  if (![...taken].some((id) => Object.hasOwn(attributes, id))) return attributes;
  return Object.fromEntries(Object.entries(attributes).filter(([id]) => !taken.has(id)));
}
