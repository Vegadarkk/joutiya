import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { ListingCatalogue } from "@/components/listing/listing-catalogue";
import { PriceTag } from "@/components/listing/price-tag";
import { activeFilterKeys, withoutFilter } from "@/components/search/filter-model";
import type { ListingVariants } from "@/lib/contracts/catalog";
import { initialSelection, selectedKey, valueState } from "@/lib/listings/client/variant-picker";
import { listingJsonLd } from "@/lib/listings/jsonld";
import type { PublicListing } from "@/lib/listings/public";
import { toSearchCard } from "@/lib/search/cards";
import type { CardDocument } from "@/lib/search/types";

vi.mock("server-only", () => ({}));
const { cardCatalogue } = await import("@/lib/listings/public");

// Pro catalogue, lot 4 PR 3 (design phase-7/catalogue-boutique.md §2-3): what buyers see. The
// picker's value states, the card price and « Épuisé » mark, the page's picker and stock line,
// the Product markup, and the « inclure les épuisés » filter.

const dress: ListingVariants = {
  axes: [
    { id: "clothing-size", values: ["s", "m", "l"] },
    { id: "color", values: ["beige", "vert"] },
  ],
  items: [
    { key: "s|beige", stock: 4 },
    { key: "m|beige", stock: 0 },
    { key: "m|vert", stock: 2 },
    { key: "l|beige", stock: 0 },
    { key: "l|vert", price: 450 },
  ],
};

describe("variant picker states", () => {
  it("starts with lone values chosen and gives a key once every axis has one", () => {
    expect(initialSelection({ axes: [{ id: "free-1", label: "Contenance", values: ["1 L"] }, { id: "color", values: ["noir", "blanc"] }] })).toEqual(["1 L", undefined]);
    expect(selectedKey(["m", undefined])).toBeNull();
    expect(selectedKey(["m", "vert"])).toBe("m|vert");
  });

  it("marks a value sold out when every match is, absent when none is offered", () => {
    expect(valueState(dress, 0, "s", [undefined, undefined])).toBe("available");
    expect(valueState(dress, 0, "m", [undefined, "beige"])).toBe("sold_out");
    expect(valueState(dress, 0, "s", [undefined, "vert"])).toBe("absent");
    expect(valueState(dress, 1, "beige", ["l", undefined])).toBe("sold_out");
    // Untracked stock counts as available.
    expect(valueState(dress, 1, "vert", ["l", undefined])).toBe("available");
  });
});

describe("cards", () => {
  it("show the lowest combination price, « à partir de » and « Épuisé »", () => {
    expect(cardCatalogue({ price: 420, isDonation: false, variants: dress })).toEqual({ price: 420, priceFrom: true });
    expect(cardCatalogue({ price: 420, isDonation: false, stock: 0 })).toEqual({ price: 420, soldOut: true });
    const cheaper: ListingVariants = { axes: [{ id: "free-1", label: "Contenance", values: ["1 L", "100 ml"] }], items: [{ key: "1 L" }, { key: "100 ml", price: 90, stock: 0 }] };
    expect(cardCatalogue({ price: 650, isDonation: false, variants: cheaper })).toEqual({ price: 90, priceFrom: true });
    expect(cardCatalogue({ price: 300, isDonation: false })).toEqual({ price: 300 });
  });

  it("keep the engine's marks", () => {
    const doc = { id: "abcd2345", slugId: "robe-fes-abcd2345", title: "Robe", subcategoryId: "vetements", price: 420, priceNegotiable: false, isDonation: false, citySlug: "fes", photo: undefined, photoCount: 0, sellerType: "pro", sortAt: 0, isBumped: false, soldOut: true, priceFrom: true } as unknown as CardDocument;
    expect(toSearchCard(doc, new Date())).toMatchObject({ soldOut: true, priceFrom: true, price: 420 });
  });

  it("price tag reads « À partir de »", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr}>
        <PriceTag price={420} isDonation={false} from locale="fr" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("À partir de");
  });
});

describe("listing page", () => {
  const render = (catalogue: Parameters<typeof ListingCatalogue>[0]["catalogue"], axes = [{ name: "Taille", values: ["S", "M", "L"] }, { name: "Couleur", values: ["Beige", "Vert"] }]) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr}>
        <ListingCatalogue listingId="abcd2345" catalogue={catalogue} axes={axes} price={420} locale="fr" />
      </NextIntlClientProvider>,
    );

  it("shows the declared stock without variants", () => {
    expect(render({ stock: 3, variants: null })).toContain("Plus que 3 en stock");
    expect(render({ stock: 0, variants: null })).toContain("Épuisé");
    expect(render({ stock: null, variants: null })).toBe("");
  });

  it("lists every value per axis, and asks for a choice", () => {
    const html = render({ stock: null, variants: dress });
    expect(html).toContain("Taille");
    expect(html).toContain("Couleur");
    expect(html.match(/role="radio"/g)).toHaveLength(5);
    expect(html).toContain(fr.ListingPage.catalogue.choose);
    expect(html).not.toContain("Article épuisé");
  });

  it("says the article is sold out when every combination is", () => {
    const html = render({ stock: null, variants: { axes: [{ id: "color", values: ["noir"] }], items: [{ key: "noir", stock: 0 }] } }, [{ name: "Couleur", values: ["Noir"] }]);
    expect(html).toContain("Article épuisé");
    // A lone value is chosen: its line shows at once.
    expect(html).toContain('data-state="sold_out"');
  });
});

describe("Product markup", () => {
  const listing = (overrides: Partial<PublicListing>): PublicListing => ({
    id: "abcd2345",
    slugId: "robe-fes-abcd2345",
    state: "published",
    title: "Robe d'été",
    description: "Robe en lin.",
    categoryId: "mode",
    subcategoryId: "vetements",
    attributes: {},
    condition: "new_tagged",
    price: 420,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "03", citySlug: "fes", district: null },
    photos: [],
    contact: { showPhone: false, whatsapp: false },
    seller: { publicId: "p", name: "Atelier", type: "pro" },
    example: false,
    rental: null,
    catalogue: null,
    publishedAt: "2026-10-29T00:00:00.000Z",
    sortAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  });
  const offers = (overrides: Partial<PublicListing>) => listingJsonLd({ listing: listing(overrides), url: "https://joutiya.ma/fr/annonce/robe-fes-abcd2345", images: [] }).offers as Record<string, unknown>;

  it("is an AggregateOffer over the combinations' prices", () => {
    expect(offers({ catalogue: { stock: null, variants: dress } })).toMatchObject({ "@type": "AggregateOffer", lowPrice: "420", highPrice: "450", offerCount: 5, availability: "https://schema.org/InStock" });
  });

  it("is out of stock at a declared 0", () => {
    expect(offers({ catalogue: { stock: 0, variants: null } })).toMatchObject({ "@type": "Offer", price: "420", availability: "https://schema.org/OutOfStock" });
  });
});

describe("search filter", () => {
  it("shows « Épuisés inclus » as a removable chip", () => {
    expect(activeFilterKeys({ includeSoldOut: true })).toEqual(["includeSoldOut"]);
    expect(withoutFilter({ includeSoldOut: true, q: "robe" }, "includeSoldOut")).toEqual({ q: "robe" });
  });
});
