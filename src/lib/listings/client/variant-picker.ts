import type { ListingVariants } from "@/lib/contracts/catalog";
import { VARIANT_KEY_SEPARATOR, itemAvailable, variantKey } from "@/lib/contracts/catalog-core";

// The variant picker of a listing page (catalogue §2, buyer side), pure and zod-free: the page's
// JavaScript bundles it. Unit-tested.

/** A value of an axis given the other axes' choices: sold, every match sold out, or no combination offered. */
export type ValueState = "available" | "sold_out" | "absent";

/** Choices per axis: a lone value is chosen from the start. */
export function initialSelection(variants: Pick<ListingVariants, "axes">): (string | undefined)[] {
  return variants.axes.map((axis) => (axis.values.length === 1 ? axis.values[0] : undefined));
}

/** The combination key once every axis has a choice, else null. */
export function selectedKey(selection: readonly (string | undefined)[]): string | null {
  return selection.length > 0 && selection.every((value): value is string => value !== undefined) ? variantKey(selection) : null;
}

/** State of `value` on axis `axisIndex`, the other axes' choices kept (an unchosen axis matches every value). */
export function valueState(variants: Pick<ListingVariants, "items">, axisIndex: number, value: string, selection: readonly (string | undefined)[]): ValueState {
  const matches = variants.items.filter((item) =>
    item.key.split(VARIANT_KEY_SEPARATOR).every((part, index) => (index === axisIndex ? part === value : selection[index] === undefined || selection[index] === part)),
  );
  if (matches.length === 0) return "absent";
  return matches.some(itemAvailable) ? "available" : "sold_out";
}
