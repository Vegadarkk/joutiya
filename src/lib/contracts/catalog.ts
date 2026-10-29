import { z } from "@/lib/zod";
import { CRITERION_TEXT_MAX, criterionById } from "@/config/categories";
import { refKey } from "./stock-import";

// Shop catalogue of a Pro listing (lot 4, design phase-7/catalogue-boutique.md §2-3): variants on
// one or two axes (size, colour, a free axis such as « Contenance »), a declared stock, per
// combination or for the whole listing. Joutiya never sells nor counts sales: the stock is what
// the Pro declares. Client-safe (the wizard, the listing page and the server share it).

/** Axes of a listing (« Taille » x « Couleur »). */
export const VARIANT_AXES_MAX = 2;
/** Values of one axis. */
export const VARIANT_VALUES_MAX = 20;
/** Combinations of a listing; variants never count as listings. */
export const VARIANT_ITEMS_MAX = 50;
/** A free axis's label and values (« Contenance », « 500 g »). */
export const VARIANT_LABEL_MAX = 20;
export const VARIANT_VALUE_MAX = 20;
/** Declared stock, per listing or combination. */
export const STOCK_MAX = 9_999;
/** « Plus que N en stock » from this level down (0 reads « Épuisé »). */
export const LOW_STOCK = 5;
/** Integer MAD (PRICE_MAX of listings: contracts/listings.ts imports this module). */
const VARIANT_PRICE_MAX = 100_000_000;

/**
 * Criteria an axis may take over, so the search filters keep working (« taille 42 disponible »).
 * Their values are the criterion's options; the listing's attribute for it gives way to the axis.
 */
export const VARIANT_CRITERIA = ["clothing-size", "shoe-size", "color"] as const;
export type VariantCriterion = (typeof VARIANT_CRITERIA)[number];
/** Free axes: their own label, values typed by the Pro and screened like the title. */
export const FREE_AXES = ["free-1", "free-2"] as const;
export type FreeAxis = (typeof FREE_AXES)[number];
export type VariantAxisId = VariantCriterion | FreeAxis;

/** Joins the values of a combination, axis order (`"m|bleu"`); values never hold it. */
export const VARIANT_KEY_SEPARATOR = "|";

export const isVariantCriterion = (id: string): id is VariantCriterion => (VARIANT_CRITERIA as readonly string[]).includes(id);

export const stockSchema = z.number().int().min(0).max(STOCK_MAX);

const valueSchema = z
  .string()
  .trim()
  .min(1)
  .max(VARIANT_VALUE_MAX)
  .refine((value) => !value.includes(VARIANT_KEY_SEPARATOR), { message: "separator" });

export const variantAxisSchema = z
  .object({
    id: z.enum([...VARIANT_CRITERIA, ...FREE_AXES]),
    /** Free axes only (a criterion axis takes its translated label). */
    label: z.string().trim().min(1).max(VARIANT_LABEL_MAX).optional(),
    values: z.array(valueSchema).min(1).max(VARIANT_VALUES_MAX),
  })
  .strict();
export type VariantAxis = z.infer<typeof variantAxisSchema>;

export const variantItemSchema = z
  .object({
    /** `variantKey` of its values. */
    key: z.string().min(1).max(VARIANT_AXES_MAX * (VARIANT_VALUE_MAX + 1)),
    /** Absent: not tracked. */
    stock: stockSchema.optional(),
    /** Absent: the listing's price. */
    price: z.number().int().min(1).max(VARIANT_PRICE_MAX).optional(),
    /** The Pro's reference (like the `stock-ref` criterion). */
    ref: z.string().trim().min(1).max(CRITERION_TEXT_MAX).optional(),
  })
  .strict();
export type VariantItem = z.infer<typeof variantItemSchema>;

export function variantKey(values: readonly string[]): string {
  return values.join(VARIANT_KEY_SEPARATOR);
}

/** Every combination of the axes, axis order (the first axis varies slowest). */
export function variantCombinations(axes: readonly Pick<VariantAxis, "values">[]): string[] {
  let keys: string[][] = [[]];
  for (const axis of axes) keys = keys.flatMap((prefix) => axis.values.map((value) => [...prefix, value]));
  return axes.length === 0 ? [] : keys.map(variantKey);
}

/** Values compare without case or surrounding spaces (« 500 g » twice is one value). */
const valueKey = (value: string) => value.trim().toLowerCase();

function checkVariants(variants: { axes: VariantAxis[]; items: VariantItem[] }, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  variants.axes.forEach((axis, index) => {
    const path = ["axes", index];
    if (ids.has(axis.id)) ctx.addIssue({ code: "custom", path: [...path, "id"], message: "duplicate axis" });
    ids.add(axis.id);
    if (isVariantCriterion(axis.id)) {
      const options = criterionById(axis.id)?.options ?? [];
      axis.values.forEach((value, at) => {
        if (!options.includes(value)) ctx.addIssue({ code: "custom", path: [...path, "values", at], message: "unknown option" });
      });
    } else if (!axis.label) {
      ctx.addIssue({ code: "custom", path: [...path, "label"], message: "label required" });
    }
    const seen = new Set<string>();
    axis.values.forEach((value, at) => {
      if (seen.has(valueKey(value))) ctx.addIssue({ code: "custom", path: [...path, "values", at], message: "duplicate value" });
      seen.add(valueKey(value));
    });
  });
  const combinations = new Set(variantCombinations(variants.axes));
  const keys = new Set<string>();
  const refs = new Set<string>();
  variants.items.forEach((item, index) => {
    if (!combinations.has(item.key)) ctx.addIssue({ code: "custom", path: ["items", index, "key"], message: "unknown combination" });
    if (keys.has(item.key)) ctx.addIssue({ code: "custom", path: ["items", index, "key"], message: "duplicate combination" });
    keys.add(item.key);
    if (item.ref !== undefined) {
      if (refs.has(refKey(item.ref))) ctx.addIssue({ code: "custom", path: ["items", index, "ref"], message: "duplicate reference" });
      refs.add(refKey(item.ref));
    }
  });
}

/**
 * Variants of a listing: 1 or 2 axes, up to 50 combinations among their product (a combination the
 * shop does not sell is left out). Stored as sent, the listing's own `stock` then stays absent.
 */
export const listingVariantsSchema = z
  .object({
    axes: z.array(variantAxisSchema).min(1).max(VARIANT_AXES_MAX),
    items: z.array(variantItemSchema).min(1).max(VARIANT_ITEMS_MAX),
  })
  .strict()
  .superRefine(checkVariants);
export type ListingVariants = z.infer<typeof listingVariantsSchema>;

/** `PUT /api/listings/{id}/stock`: the stock alone, no full moderation (catalogue §3). */
export const stockUpdateSchema = z
  .object({
    /** A listing without variants; null: no longer tracked. */
    stock: stockSchema.nullable().optional(),
    /** Combinations of a listing with variants, by key; null: no longer tracked. */
    items: z
      .array(z.object({ key: variantItemSchema.shape.key, stock: stockSchema.nullable() }).strict())
      .min(1)
      .max(VARIANT_ITEMS_MAX)
      .optional(),
  })
  .strict()
  .refine((input) => (input.stock !== undefined) !== (input.items !== undefined), { message: "stock or items" });
export type StockUpdateInput = z.infer<typeof stockUpdateSchema>;

/** What the stock of a listing or combination shows. */
export type StockState = "untracked" | "in_stock" | "low" | "sold_out";

export function stockState(stock: number | undefined | null): StockState {
  if (stock === undefined || stock === null) return "untracked";
  if (stock <= 0) return "sold_out";
  return stock <= LOW_STOCK ? "low" : "in_stock";
}

type Catalogue = { stock?: number | undefined; variants?: ListingVariants | undefined };

/** Stock 0 everywhere it is tracked, and tracked everywhere: sold out (decision 1, still online). */
export function isSoldOut(listing: Catalogue): boolean {
  if (listing.variants) return listing.variants.items.every((item) => item.stock === 0);
  return listing.stock === 0;
}

/** Combination still sold: stock not tracked, or above 0. */
export const itemAvailable = (item: Pick<VariantItem, "stock">) => item.stock === undefined || item.stock > 0;

/**
 * Lowest and highest price of a listing with variants (a combination without its own price takes
 * the listing's), or null when no price applies (« à discuter », a donation).
 */
export function priceRange(listing: Catalogue & { price: number | null; isDonation: boolean }): { min: number; max: number } | null {
  if (listing.isDonation) return null;
  const prices = listing.variants ? listing.variants.items.map((item) => item.price ?? listing.price) : [listing.price];
  const known = prices.filter((price): price is number => price !== null);
  if (known.length === 0) return null;
  return { min: Math.min(...known), max: Math.max(...known) };
}

/** Values of `axisId` with at least one combination still sold, axis order. */
export function availableValues(variants: ListingVariants, axisId: VariantAxisId): string[] {
  const index = variants.axes.findIndex((axis) => axis.id === axisId);
  const axis = variants.axes[index];
  if (!axis) return [];
  const sold = new Set(variants.items.filter(itemAvailable).map((item) => item.key.split(VARIANT_KEY_SEPARATOR)[index]));
  return axis.values.filter((value) => sold.has(value));
}

/** Criterion ids the variants take over (their attribute gives way to the axis). */
export function variantCriteria(variants: Pick<ListingVariants, "axes"> | undefined | null): VariantCriterion[] {
  return (variants?.axes ?? []).map((axis) => axis.id).filter(isVariantCriterion);
}

/**
 * The attributes with each criterion an axis takes over answered by the axis (its first value
 * stands for it): « Taille », required on clothes, is met by sizes S to XL. `criteria`: the ids of
 * the subcategory's criteria (an axis outside them is the readiness's `variants_axis_invalid`).
 */
export function withVariantAnswers<T extends Record<string, unknown>>(attributes: T, variants: Pick<ListingVariants, "axes"> | undefined | null, criteria: readonly string[]): T {
  if (variantCriteria(variants).length === 0) return attributes;
  const answered: Record<string, unknown> = { ...attributes };
  for (const axis of variants?.axes ?? []) if (isVariantCriterion(axis.id) && criteria.includes(axis.id) && axis.values[0] !== undefined) answered[axis.id] = axis.values[0];
  return answered as T;
}
