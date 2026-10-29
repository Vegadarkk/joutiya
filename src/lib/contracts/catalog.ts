import { z } from "@/lib/zod";
import { CRITERION_TEXT_MAX, criterionById } from "@/config/categories";
import { PROMO_KINDS, VARIANT_KEY_SEPARATOR, itemAvailable, variantKey } from "./catalog-core";
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

// The zod-free part (the listing page's picker bundles it without the schemas).
export { LOW_STOCK, VARIANT_KEY_SEPARATOR, isSoldOut, itemAvailable, stockState, variantKey, type StockState } from "./catalog-core";

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


type Catalogue = { stock?: number | undefined; variants?: ListingVariants | undefined };

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

// ---- Promotions (catalogue §4; owner decisions 2-4 of 28 Oct 2026; law 31-08 art. 53-55)

export { PROMO_KINDS, cardPromo, percentOff, promoRunning, promoSummary, type CardPromo, type PromoKind, type PromoPrice, type PromoView } from "./catalog-core";

const HOUR_MS = 60 * 60 * 1000;
/** Shortest promotion. */
export const PROMO_MIN_MS = HOUR_MS;
/** Longest promotion (a « Vente flash » is shorter, FLASH_MAX_MS). */
export const PROMO_MAX_MS = 30 * 24 * HOUR_MS;
/** Decision 4: a flash sale lasts 72 hours at most. */
export const FLASH_MAX_MS = 72 * HOUR_MS;
/** Decision 4: at least 7 days between the end of a promotion and the start of the next. */
export const PROMO_GAP_MS = 7 * 24 * HOUR_MS;
/** How far ahead a promotion may be scheduled. */
export const PROMO_AHEAD_MS = 30 * 24 * HOUR_MS;
/** A cut above this (against the struck-out price, else the current one) is held for a moderator. */
export const PROMO_REVIEW_PERCENT = 70;
export const PROMO_PERCENT_MIN = 1;
export const PROMO_PERCENT_MAX = 90;

/**
 * `PUT /api/listings/{id}/promo`: one cut for every price (`percent`), or the new price of a
 * listing without variants (`price`). Joutiya computes the struck-out price, never the Pro.
 * `startsAt` absent: now.
 */
export const promoInputSchema = z
  .object({
    kind: z.enum(PROMO_KINDS),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }),
    percent: z.number().int().min(PROMO_PERCENT_MIN).max(PROMO_PERCENT_MAX).optional(),
    price: z.number().int().min(1).max(VARIANT_PRICE_MAX).optional(),
  })
  .strict()
  .refine((input) => (input.percent !== undefined) !== (input.price !== undefined), { message: "percent or price", path: ["percent"] });
export type PromoInput = z.infer<typeof promoInputSchema>;

/** The words a title may hold only during « Soldes » (art. 53: the word is reserved to them). */
export const SOLDES_PATTERN = /(^|[^\p{L}])soldes?(?![\p{L}])/iu;

// ---- Shop sections (catalogue §5)

/** Sections (« rayons ») of a shop: « Ramadan », « Rentrée »… shown as storefront tabs. */
export const SHOP_SECTIONS_MAX = 12;
export const SHOP_SECTION_NAME_MAX = 30;
export const SECTION_ID_PATTERN = /^[a-z0-9]{6}$/;
export const sectionIdSchema = z.string().regex(SECTION_ID_PATTERN);
const sectionNameSchema = z.string().trim().min(1).max(SHOP_SECTION_NAME_MAX);
const distinctNames = (sections: readonly { name: string }[]) => new Set(sections.map((section) => section.name.toLocaleLowerCase("fr"))).size === sections.length;

export const shopSectionSchema = z.object({ id: sectionIdSchema, name: sectionNameSchema }).strict();
export type ShopSection = z.infer<typeof shopSectionSchema>;
export const shopSectionsSchema = z
  .array(shopSectionSchema)
  .max(SHOP_SECTIONS_MAX)
  .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length && distinctNames(sections), { message: "duplicate section" });

/** `PUT /api/pro/me/sections`: the list replaced whole, in display order; a new section has no id yet. */
export const sectionsInputSchema = z
  .object({ sections: z.array(z.object({ id: sectionIdSchema.optional(), name: sectionNameSchema }).strict()).max(SHOP_SECTIONS_MAX).refine(distinctNames, { message: "duplicate name" }) })
  .strict();
export type SectionsInput = z.infer<typeof sectionsInputSchema>;
export type SectionsResponse = { sections: ShopSection[] };

/** `PUT /api/listings/{id}/section`: the listing's section, null to take it out. */
export const sectionUpdateSchema = z.object({ sectionId: sectionIdSchema.nullable() }).strict();
export type SectionUpdateInput = z.infer<typeof sectionUpdateSchema>;
