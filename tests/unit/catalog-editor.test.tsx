import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { stockSummary } from "@/components/listings/owner/owner-stock";
import { VariantsEditor } from "@/components/post/variants-editor";
import { subcategoryById } from "@/config/categories";
import { VARIANT_ITEMS_MAX, type ListingVariants } from "@/lib/contracts/catalog";
import {
  attributesWithoutAxes,
  axisChoices,
  cleanValue,
  combinationCount,
  hasValue,
  keyValues,
  nextFreeAxis,
  rebuildItems,
  remainingAxes,
  variantsPatch,
} from "@/lib/listings/client/variants";

// Pro catalogue, lot 4 PR 2 (design phase-7/catalogue-boutique.md §2-3): the wizard's variants
// block (axes offered by the subcategory, combinations kept in step with the axes, the patch it
// saves) and the stock summary of "Mes annonces".

const clothes = subcategoryById("vetements")!;
const shoes = subcategoryById("chaussures")!;

describe("variant axes offered", () => {
  it("offers the subcategory's variant criteria first, then the free axes", () => {
    expect(axisChoices(clothes)).toEqual(["clothing-size", "color", "free-1", "free-2"]);
    expect(axisChoices(shoes)).toEqual(["shoe-size", "color", "free-1", "free-2"]);
    expect(axisChoices(undefined)).toEqual(["free-1", "free-2"]);
  });

  it("leaves out the axes taken, and offers none past two", () => {
    expect(remainingAxes(clothes, [{ id: "color" }])).toEqual(["clothing-size", "free-1", "free-2"]);
    expect(remainingAxes(clothes, [{ id: "color" }, { id: "free-1" }])).toEqual([]);
    expect(nextFreeAxis([{ id: "free-1" }])).toBe("free-2");
    expect(nextFreeAxis([{ id: "free-1" }, { id: "free-2" }])).toBeUndefined();
  });
});

describe("combinations", () => {
  const before = [{ values: ["s", "m"] }];

  it("keeps what the Pro set, offers new combinations and keeps an unticked one out", () => {
    const items = [{ key: "s", stock: 3, price: 150 }];
    // "m" was a combination before and is not in items: the Pro unticked it.
    const after = [{ values: ["s", "m", "l"] }];
    expect(rebuildItems(before, after, items)).toEqual([{ key: "s", stock: 3, price: 150 }, { key: "l" }]);
  });

  it("rebuilds every key when a second axis comes in", () => {
    const items = [{ key: "s", stock: 3 }, { key: "m" }];
    const after = [{ values: ["s", "m"] }, { values: ["Noir", "Blanc"] }];
    expect(rebuildItems(before, after, items).map((item) => item.key)).toEqual(["s|Noir", "s|Blanc", "m|Noir", "m|Blanc"]);
  });

  it("caps the combinations and counts what the axes make", () => {
    const sizes = Array.from({ length: 10 }, (_, index) => `T${index}`);
    const colors = Array.from({ length: 6 }, (_, index) => `C${index}`);
    const axes = [{ values: sizes }, { values: colors }];
    expect(rebuildItems([], axes, [])).toHaveLength(VARIANT_ITEMS_MAX);
    expect(combinationCount(axes)).toBe(60);
    expect(combinationCount([])).toBe(0);
    expect(keyValues("m|Noir")).toEqual(["m", "Noir"]);
  });
});

describe("free values", () => {
  it("cleans a typed value and compares without case or spaces", () => {
    expect(cleanValue("  Rouge |  brique ")).toBe("Rouge brique");
    expect(cleanValue("x".repeat(30))).toHaveLength(20);
    expect(cleanValue(" | ")).toBe("");
    expect(hasValue(["Rouge"], " rouge ")).toBe(true);
    expect(hasValue(["Rouge"], "Bleu")).toBe(false);
  });
});

describe("variants patch", () => {
  it("is the stored variants once complete, null while not", () => {
    const axes = [{ id: "clothing-size" as const, values: ["s", "m"] }];
    expect(variantsPatch(axes, [{ key: "s", stock: 2 }, { key: "m" }])).toEqual({ axes, items: [{ key: "s", stock: 2 }, { key: "m" }] });
    expect(variantsPatch(axes, [])).toBeNull();
    expect(variantsPatch([{ id: "free-1", values: [] }], [])).toBeNull();
  });

  it("drops the criteria the axes take over from the attributes", () => {
    const attributes = { audience: "femme", "clothing-size": "m", color: "noir" };
    expect(attributesWithoutAxes(attributes, [{ id: "clothing-size" }, { id: "free-1" }])).toEqual({ audience: "femme", color: "noir" });
    expect(attributesWithoutAxes(attributes, [{ id: "free-1" }])).toBe(attributes);
  });
});

describe("stock summary of Mes annonces", () => {
  const variants = (stocks: (number | undefined)[]): ListingVariants => ({
    axes: [{ id: "free-1", label: "Contenance", values: stocks.map((_, index) => `${index + 1} L`) }],
    items: stocks.map((stock, index) => ({ key: `${index + 1} L`, ...(stock === undefined ? {} : { stock }) })),
  });

  it("reads the listing's own stock", () => {
    expect(stockSummary({ stock: null, variants: null })).toMatchObject({ key: "untracked", tone: "muted" });
    expect(stockSummary({ stock: 0, variants: null })).toMatchObject({ key: "soldOut", tone: "danger" });
    expect(stockSummary({ stock: 3, variants: null })).toMatchObject({ key: "low", values: { count: 3 }, tone: "warning" });
    expect(stockSummary({ stock: 40, variants: null })).toMatchObject({ key: "count", values: { count: 40 } });
  });

  it("reads the combinations", () => {
    expect(stockSummary({ stock: null, variants: variants([0, 0]) })).toMatchObject({ key: "soldOut" });
    expect(stockSummary({ stock: null, variants: variants([0, 4, undefined]) })).toMatchObject({ key: "variantsSoldOut", values: { count: 3, out: 1 } });
    expect(stockSummary({ stock: null, variants: variants([2, undefined]) })).toMatchObject({ key: "variants", values: { count: 2 } });
  });
});

describe("variants editor", () => {
  const render = (variants: ListingVariants | null) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr}>
        <VariantsEditor subcategory={clothes} price={200} variants={variants} stock={null} onChange={() => undefined} onBlur={() => undefined} />
      </NextIntlClientProvider>,
    );

  it("offers a single item by default", () => {
    const html = render(null);
    expect(html).toContain(fr.Listing.catalogue.single);
    expect(html).toContain(fr.Listing.catalogue.trackStock);
  });

  it("lists the combinations of saved variants", () => {
    const html = render({ axes: [{ id: "clothing-size", values: ["s", "m"] }, { id: "free-1", label: "Coupe", values: ["Droite"] }], items: [{ key: "s|Droite", stock: 4 }, { key: "m|Droite" }] });
    expect(html).toContain("Coupe");
    expect(html).toContain("Droite");
    expect(html).toContain(fr.Listing.catalogue.combinations);
  });
});
