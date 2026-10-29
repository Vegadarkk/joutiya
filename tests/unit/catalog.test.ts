import { describe, expect, it } from "vitest";
import { cityBySlug } from "@/config/regions";
import {
  VARIANT_ITEMS_MAX,
  availableValues,
  isSoldOut,
  listingVariantsSchema,
  priceRange,
  stockState,
  stockUpdateSchema,
  variantCombinations,
  variantKey,
  type ListingVariants,
} from "@/lib/contracts/catalog";
import { listingPatchSchema } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { ListingDoc, PriceLogEntry } from "@/lib/db/schemas";
import { PRICE_LOG_DAYS, effectivePrices, logPrices, prunePriceLog } from "@/lib/listings/catalog";
import { planPromo, promoEnd, promoView, referencePrices } from "@/lib/listings/promo";
import { assessReadiness, issuesByPath, type SellerFacts } from "@/lib/listings/readiness";
import { toSearchDocument } from "@/lib/search/document";
import { buildFilter, promoRunningFilter, sortSpecs } from "@/lib/search/service";

// Pro catalogue, lot 4 PR 1 (design phase-7/catalogue-boutique.md §2-4): the variants contract,
// stock states, the price history behind a promotion's struck-out price, the publish readiness
// (Pros only, owner decision 5) and what the search index keeps (decision 1: sold out stays online).

const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PRO: SellerFacts = { seller: { type: "pro", plan: "essentiel" }, phoneVerified: true };
const INDIVIDUAL: SellerFacts = { seller: { type: "individual" }, phoneVerified: true };
const casablanca = cityBySlug("casablanca")!;

const SIZES: ListingVariants = {
  axes: [
    { id: "clothing-size", values: ["s", "m", "l"] },
    { id: "color", values: ["bleu", "noir"] },
  ],
  items: [
    { key: "s|bleu", stock: 0 },
    { key: "m|bleu", stock: 3, price: 290 },
    { key: "l|noir", stock: 0, ref: "CHM-L-N" },
  ],
};

function shirt(overrides: Partial<ListingDoc> = {}): ListingRecord {
  return {
    id: "abcdefgh",
    ownerUid: "uid-1",
    proId: "shop0001",
    sellerType: "pro",
    sellerName: "Atelier Nour",
    sellerPublicId: "abcdefghjk",
    status: "published",
    slugId: "chemise-en-lin-casablanca-abcdefgh",
    title: "Chemise en lin brodée main",
    description: "Chemise en lin lavé, broderie faite main à Fès, coupe droite, plusieurs tailles et couleurs.",
    categoryId: "mode",
    subcategoryId: "vetements",
    attributes: { audience: "homme", "clothing-type": "haut" },
    condition: "new_tagged",
    price: 250,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: casablanca.regionCode, citySlug: casablanca.slug, geo: { lat: casablanca.lat, lng: casablanca.lng } },
    photos: [{ id: "photo000000000001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60 * DAY),
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    variants: SIZES,
    ...overrides,
  };
}

describe("variants contract", () => {
  it("builds the combinations of the axes, first axis slowest", () => {
    expect(variantCombinations(SIZES.axes)).toEqual(["s|bleu", "s|noir", "m|bleu", "m|noir", "l|bleu", "l|noir"]);
    expect(variantKey(["500 g"])).toBe("500 g");
    expect(variantCombinations([])).toEqual([]);
  });

  it("accepts criterion axes with their options and a labelled free axis", () => {
    expect(listingVariantsSchema.safeParse(SIZES).success).toBe(true);
    const honey = { axes: [{ id: "free-1", label: "Contenance", values: ["250 g", "500 g", "1 kg"] }], items: [{ key: "250 g", price: 90 }, { key: "1 kg", price: 320, stock: 4 }] };
    expect(listingVariantsSchema.safeParse(honey).success).toBe(true);
  });

  it.each([
    ["an option the criterion does not have", { axes: [{ id: "clothing-size", values: ["enorme"] }], items: [{ key: "enorme" }] }],
    ["a free axis without its label", { axes: [{ id: "free-1", values: ["250 g"] }], items: [{ key: "250 g" }] }],
    ["the same axis twice", { axes: [{ id: "color", values: ["bleu"] }, { id: "color", values: ["noir"] }], items: [{ key: "bleu|noir" }] }],
    ["the same value twice, whatever the case", { axes: [{ id: "free-1", label: "Contenance", values: ["500 g", "500 G"] }], items: [{ key: "500 g" }] }],
    ["a value holding the separator", { axes: [{ id: "free-1", label: "Pack", values: ["2|3"] }], items: [{ key: "2|3" }] }],
    ["a combination outside the axes", { axes: [{ id: "color", values: ["bleu"] }], items: [{ key: "noir" }] }],
    ["a combination twice", { axes: [{ id: "color", values: ["bleu"] }], items: [{ key: "bleu" }, { key: "bleu", stock: 2 }] }],
    ["one reference on two combinations", { axes: [{ id: "color", values: ["bleu", "noir"] }], items: [{ key: "bleu", ref: "A1" }, { key: "noir", ref: " a1 " }] }],
    ["three axes", { axes: [{ id: "color", values: ["bleu"] }, { id: "free-1", label: "A", values: ["x"] }, { id: "free-2", label: "B", values: ["y"] }], items: [{ key: "bleu|x|y" }] }],
    ["a stock above 9 999", { axes: [{ id: "color", values: ["bleu"] }], items: [{ key: "bleu", stock: 10_000 }] }],
    ["an unknown field", { axes: [{ id: "color", values: ["bleu"] }], items: [{ key: "bleu", promo: 10 }] }],
  ])("refuses %s", (_label, variants) => {
    expect(listingVariantsSchema.safeParse(variants).success).toBe(false);
  });

  it("caps the combinations at 50", () => {
    const values = Array.from({ length: 20 }, (_, index) => `v${index}`);
    const axes = [
      { id: "free-1" as const, label: "A", values },
      { id: "free-2" as const, label: "B", values: ["x", "y", "z"] },
    ];
    const items = variantCombinations(axes).map((key) => ({ key }));
    expect(items.length).toBeGreaterThan(VARIANT_ITEMS_MAX);
    expect(listingVariantsSchema.safeParse({ axes, items }).success).toBe(false);
    expect(listingVariantsSchema.safeParse({ axes, items: items.slice(0, VARIANT_ITEMS_MAX) }).success).toBe(true);
  });

  it("travels in a listing patch, null removing it", () => {
    expect(listingPatchSchema.safeParse({ variants: SIZES, stock: null }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ variants: null, stock: 12 }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ stock: -1 }).success).toBe(false);
  });

  it("takes a stock update for the listing or for combinations, not both", () => {
    expect(stockUpdateSchema.safeParse({ stock: 4 }).success).toBe(true);
    expect(stockUpdateSchema.safeParse({ stock: null }).success).toBe(true);
    expect(stockUpdateSchema.safeParse({ items: [{ key: "m|bleu", stock: 0 }] }).success).toBe(true);
    expect(stockUpdateSchema.safeParse({}).success).toBe(false);
    expect(stockUpdateSchema.safeParse({ stock: 1, items: [{ key: "m|bleu", stock: 0 }] }).success).toBe(false);
  });
});

describe("stock and prices", () => {
  it("reads the stock state", () => {
    expect([undefined, 0, 1, 5, 6].map(stockState)).toEqual(["untracked", "sold_out", "low", "low", "in_stock"]);
  });

  it("is sold out only when every combination is tracked at 0", () => {
    expect(isSoldOut({ variants: SIZES })).toBe(false);
    expect(isSoldOut({ variants: { ...SIZES, items: SIZES.items.map((item) => ({ ...item, stock: 0 })) } })).toBe(true);
    expect(isSoldOut({ variants: { ...SIZES, items: [{ key: "s|bleu", stock: 0 }, { key: "m|bleu" }] } })).toBe(false);
    expect(isSoldOut({ stock: 0 })).toBe(true);
    expect(isSoldOut({})).toBe(false);
  });

  it("lists the values still sold and the price range", () => {
    expect(availableValues(SIZES, "clothing-size")).toEqual(["m"]);
    expect(availableValues(SIZES, "color")).toEqual(["bleu"]);
    expect(availableValues(SIZES, "shoe-size")).toEqual([]);
    expect(priceRange({ price: 250, isDonation: false, variants: SIZES })).toEqual({ min: 250, max: 290 });
    expect(priceRange({ price: null, isDonation: false })).toBeNull();
    expect(priceRange({ price: 0, isDonation: true })).toBeNull();
  });
});

describe("price history", () => {
  const at = (days: number) => new Date(NOW.getTime() - days * DAY);

  it("gives each combination its own price, else the listing's", () => {
    expect([...effectivePrices({ price: 250, isDonation: false, variants: SIZES })]).toEqual([
      ["s|bleu", 250],
      ["m|bleu", 290],
      ["l|noir", 250],
    ]);
    expect([...effectivePrices({ price: 100, isDonation: false })]).toEqual([["", 100]]);
  });

  it("adds a point per changed price only", () => {
    const first = logPrices(undefined, { price: 250, isDonation: false }, at(10));
    expect(first).toEqual([{ at: at(10), price: 250 }]);
    expect(logPrices(first, { price: 250, isDonation: false }, NOW)).toEqual(first);
    expect(logPrices(first, { price: 199, isDonation: false }, NOW)).toEqual([...first!, { at: NOW, price: 199 }]);
    const withVariants = logPrices(first, { price: 250, isDonation: false, variants: SIZES }, NOW);
    expect(withVariants?.slice(1)).toEqual([
      { at: NOW, price: 250, key: "s|bleu" },
      { at: NOW, price: 290, key: "m|bleu" },
      { at: NOW, price: 250, key: "l|noir" },
    ]);
  });

  it("keeps 31 days and the point in force when the window opens", () => {
    const log: PriceLogEntry[] = [
      { at: at(60), price: 400 },
      { at: at(40), price: 300 },
      { at: at(5), price: 280 },
      { at: at(50), price: 90, key: "1 kg" },
    ];
    expect(prunePriceLog(log, NOW)).toEqual([
      { at: at(50), price: 90, key: "1 kg" },
      { at: at(40), price: 300 },
      { at: at(5), price: 280 },
    ]);
    expect(PRICE_LOG_DAYS).toBe(31);
  });
});

describe("publish readiness of the catalogue", () => {
  const codes = (listing: ListingDoc, facts = PRO) => issuesByPath(assessReadiness(listing, facts));

  it("lets size variants answer the required size", () => {
    expect(assessReadiness(shirt(), PRO)).toEqual([]);
    expect(codes(shirt({ variants: undefined })).get("attributes.clothing-size")).toEqual(["criterion_required"]);
  });

  it("keeps variants and stock for Pros (owner decision 5)", () => {
    const issues = codes(shirt({ sellerType: "individual", stock: 2 }), INDIVIDUAL);
    expect(issues.get("variants")).toEqual(["variants_pro_only"]);
    expect(issues.get("stock")).toEqual(["stock_pro_only", "stock_with_variants"]);
    expect(codes(shirt({ variants: undefined, attributes: { audience: "homme", "clothing-type": "haut", "clothing-size": "m" }, stock: 2 }), INDIVIDUAL).get("stock")).toEqual(["stock_pro_only"]);
  });

  it("refuses an axis outside the subcategory and variants on a donation", () => {
    const shoes = { axes: [{ id: "shoe-size" as const, values: ["42"] }], items: [{ key: "42" }] };
    expect(codes(shirt({ variants: shoes })).get("variants.axes.0")).toEqual(["variants_axis_invalid"]);
    expect(codes(shirt({ isDonation: true, price: null })).get("variants")).toEqual(["variants_donation"]);
  });
});

describe("search document of a catalogue listing", () => {
  it("filters on the sizes still sold and indexes the lowest price", () => {
    const doc = toSearchDocument(shirt(), NOW)!;
    expect(doc["a_clothing_size"]).toEqual(["m"]);
    expect(doc["a_color"]).toEqual(["bleu"]);
    expect(doc.price).toBe(250);
    expect(doc.priceFrom).toBe(true);
    expect(doc).not.toHaveProperty("soldOut");
  });

  it("keeps a sold-out listing indexed, flagged", () => {
    const doc = toSearchDocument(shirt({ variants: { ...SIZES, items: SIZES.items.map((item) => ({ ...item, stock: 0 })) } }), NOW)!;
    expect(doc.soldOut).toBe(true);
    expect(doc["a_clothing_size"]).toEqual(["s", "m", "l"]);
    expect(toSearchDocument(shirt({ variants: undefined, attributes: { audience: "homme", "clothing-type": "haut", "clothing-size": "m" }, stock: 0 }), NOW)?.soldOut).toBe(true);
  });

  it("makes a free axis searchable text", () => {
    const honey = { axes: [{ id: "free-1" as const, label: "Contenance", values: ["250 g", "1 kg"] }], items: [{ key: "250 g", price: 90 }, { key: "1 kg", price: 90 }] };
    const doc = toSearchDocument(shirt({ variants: honey }), NOW)!;
    expect(doc.attrsText).toContain("Contenance 250 g 1 kg");
    expect(doc.price).toBe(90);
    expect(doc).not.toHaveProperty("priceFrom");
  });
});

describe("promotions (catalogue §4)", () => {
  const at = (days: number) => new Date(NOW.getTime() - days * DAY);
  const later = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
  // Published 40 days ago at 300 DH, 250 DH for the last 10 days.
  const plain = (overrides: Partial<ListingDoc> = {}) =>
    shirt({ variants: undefined, attributes: { audience: "homme", "clothing-type": "haut", "clothing-size": "m" }, price: 250, publishedAt: at(40), priceLog: [{ at: at(40), price: 300 }, { at: at(10), price: 250 }], ...overrides });

  it("strikes the lowest price of the 30 days before, none for a younger listing", () => {
    expect(referencePrices(plain(), NOW)).toEqual(new Map([["", 250]]));
    expect(referencePrices(plain({ priceLog: [{ at: at(40), price: 200 }, { at: at(10), price: 250 }] }), NOW)).toEqual(new Map([["", 200]]));
    expect(referencePrices(plain({ publishedAt: at(10) }), NOW)).toEqual(new Map([["", null]]));
    // A combination without a point before the window has no struck-out price.
    expect(referencePrices(shirt({ publishedAt: at(40), priceLog: [{ at: at(40), price: 250, key: "s|bleu" }] }), NOW)).toEqual(
      new Map([
        ["s|bleu", 250],
        ["m|bleu", null],
        ["l|noir", null],
      ]),
    );
  });

  it("plans a cut under the struck-out price", () => {
    const plan = planPromo(plain(), { kind: "promo", endsAt: later(72), percent: 20 }, NOW);
    expect(plan).toEqual({ ok: true, review: false, percent: 20, promo: { kind: "promo", startsAt: NOW, endsAt: new Date(later(72)), percent: 20, prices: [{ key: "", price: 200, reference: 250 }] } });
    expect(planPromo(plain(), { kind: "promo", endsAt: later(72), price: 199 }, NOW)).toMatchObject({ ok: true, promo: { prices: [{ key: "", price: 199, reference: 250 }] } });
    // Deeper than 70 %: a moderator checks it.
    expect(planPromo(plain(), { kind: "promo", endsAt: later(72), percent: 80 }, NOW)).toMatchObject({ ok: true, review: true, percent: 80 });
    // Younger than 30 days: no struck-out price, the cut is against the current price.
    expect(planPromo(plain({ publishedAt: at(10) }), { kind: "soldes", endsAt: later(72), percent: 10 }, NOW)).toMatchObject({ ok: true, percent: 10, promo: { prices: [{ key: "", price: 225, reference: null }] } });
  });

  it("refuses what art. 54 and the owner's rules forbid", () => {
    const issue = (input: Parameters<typeof planPromo>[1], listing = plain()) => {
      const plan = planPromo(listing, input, NOW);
      return plan.ok ? null : plan.issues;
    };
    expect(issue({ kind: "promo", endsAt: later(72), price: 260 })).toEqual([{ path: "price", code: "promo_not_lower", value: "250" }]);
    expect(issue({ kind: "promo", endsAt: later(72), percent: 10 }, plain({ priceLog: [{ at: at(40), price: 200 }, { at: at(10), price: 250 }] }))).toEqual([{ path: "percent", code: "promo_not_below_reference", value: "200" }]);
    expect(issue({ kind: "flash", endsAt: later(73), percent: 20 })).toEqual([{ path: "endsAt", code: "promo_flash_too_long" }]);
    expect(issue({ kind: "promo", endsAt: later(31 * 24), percent: 20 })).toEqual([{ path: "endsAt", code: "promo_too_long" }]);
    expect(issue({ kind: "promo", endsAt: later(0.5), percent: 20 })).toEqual([{ path: "endsAt", code: "promo_too_short" }]);
    expect(issue({ kind: "promo", startsAt: later(-1), endsAt: later(72), percent: 20 })).toEqual([{ path: "startsAt", code: "promo_start_past" }]);
    expect(issue({ kind: "promo", startsAt: later(31 * 24), endsAt: later(32 * 24), percent: 20 })).toEqual([{ path: "startsAt", code: "promo_start_far" }]);
    expect(issue({ kind: "promo", endsAt: later(72), percent: 20 }, plain({ lastPromoEndedAt: at(3) }))).toEqual([{ path: "startsAt", code: "promo_gap", value: new Date(at(3).getTime() + 7 * DAY).toISOString() }]);
    expect(issue({ kind: "promo", endsAt: later(72), price: 100 }, shirt())).toEqual([{ path: "price", code: "promo_price_with_variants" }]);
    expect(issue({ kind: "promo", endsAt: later(72), percent: 20 }, plain({ price: null }))).toEqual([{ path: "price", code: "promo_no_price" }]);
    const running = { kind: "promo" as const, startsAt: at(1), endsAt: new Date(later(24)), prices: [{ key: "", price: 200, reference: 250 }] };
    expect(issue({ kind: "promo", endsAt: later(72), percent: 20 }, plain({ promo: running }))).toEqual([{ path: "promo", code: "promo_exists" }]);
  });

  it("cuts every combination by the percentage", () => {
    const plan = planPromo(shirt(), { kind: "promo", endsAt: later(72), percent: 10 }, NOW);
    expect(plan.ok && plan.promo.prices).toEqual([
      { key: "s|bleu", price: 225, reference: null },
      { key: "m|bleu", price: 261, reference: null },
      { key: "l|noir", price: 225, reference: null },
    ]);
  });

  it("ends a promotion: a running one starts the 7-day gap, a scheduled one leaves none", () => {
    const running = { kind: "promo" as const, startsAt: at(1), endsAt: new Date(later(24)), prices: [{ key: "", price: 200, reference: 250 }] };
    expect(promoEnd({ promo: running }, NOW)).toEqual({ promo: null, lastPromoEndedAt: NOW });
    expect(promoEnd({ promo: { ...running, startsAt: new Date(later(2)) } }, NOW)).toEqual({ promo: null });
    expect(promoEnd({}, NOW)).toBeNull();
    expect(promoView({ ...running, endsAt: at(0.1) }, NOW)).toBeNull();
  });

  it("keeps « Soldes » in a title for a soldes promotion only (art. 53)", () => {
    const codes = (listing: ListingDoc) => issuesByPath(assessReadiness(listing, PRO)).get("title");
    expect(codes(plain({ title: "Chemise en lin, SOLDES d'automne" }))).toEqual(["title_soldes"]);
    expect(codes(plain({ title: "Chemise en lin - solde" }))).toEqual(["title_soldes"]);
    expect(codes(plain({ title: "Chemise en lin consoldée main" }))).toBeUndefined();
    const soldes = { kind: "soldes" as const, startsAt: at(1), endsAt: new Date(later(24)), prices: [{ key: "", price: 200, reference: 250 }] };
    expect(codes(plain({ title: "Chemise en lin, soldes d'automne", promo: soldes }))).toBeUndefined();
  });

  it("indexes the promotion; search filters and sorts on it while it runs", () => {
    const promo = { kind: "flash" as const, startsAt: at(1), endsAt: new Date(later(24)), percent: 20, prices: [{ key: "", price: 200, reference: 250 }] };
    expect(toSearchDocument(plain({ promo }), NOW)).toMatchObject({ promoKind: "flash", promoStartsAt: at(1).getTime(), promoEndsAt: new Date(later(24)).getTime(), promoPercent: 20, promoPrice: 200, promoReference: 250 });
    expect(toSearchDocument(plain(), NOW)).not.toHaveProperty("promoKind");
    expect(buildFilter({ promo: true, includeSoldOut: true }, NOW)).toEqual(promoRunningFilter(NOW));
    expect(buildFilter({ sort: "discount", includeSoldOut: true }, NOW)).toEqual(promoRunningFilter(NOW));
    expect(sortSpecs("discount", {})).toEqual([
      { field: "promoPercent", dir: "desc" },
      { field: "sortAt", dir: "desc" },
    ]);
  });
});
