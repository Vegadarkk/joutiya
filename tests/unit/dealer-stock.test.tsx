import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { DealerStock } from "@/components/pro/dealer-stock";
import { formatPrice } from "@/lib/listings/client/format";
import { DEALER_BRANDS_MAX, toDealerStock, type DealerStock as Stock } from "@/lib/search/dealer";
import { attributeField, type EngineResult } from "@/lib/search/types";

// Vehicle stock of a Pro shop on its storefront (Concession pack, design concession/concession.md
// §5): the summary built from the search facets, and its links to the search narrowed to the shop.

const result = (totalHits: number, facetDistribution?: Record<string, Record<string, number>>, price?: number): EngineResult =>
  ({ hits: price === undefined ? [] : [{ id: "abcd2345", price }], totalHits, totalPages: 1, page: 1, processingTimeMs: 1, ...(facetDistribution ? { facetDistribution } : {}) }) as unknown as EngineResult;

const facets: Record<string, Record<string, number>> = {
  subcategoryId: { voitures: 7, "motos-scooters": 2 },
  [attributeField("car-brand")]: { dacia: 4, renault: 3 },
  [attributeField("moto-brand")]: { yamaha: 2 },
  [attributeField("fuel")]: { diesel: 5, essence: 2 },
  [attributeField("gearbox")]: { manuelle: 6, automatique: 1 },
  [attributeField("trade-in")]: { true: 3, false: 6 },
  [attributeField("financing")]: { true: 2 },
  [attributeField("vehicle-warranty")]: { constructeur: 1, vendeur: 2, aucune: 4 },
};

describe("toDealerStock", () => {
  it("sums the facets into counts, brands by stock, services and the price range", () => {
    const stock = toDealerStock(result(9, facets), result(9, undefined, 45_000), result(9, undefined, 260_000));
    expect(stock).toEqual({
      total: 9,
      subcategories: [
        { value: "voitures", count: 7 },
        { value: "motos-scooters", count: 2 },
      ],
      brands: [
        { value: "dacia", count: 4, criterion: "car-brand" },
        { value: "renault", count: 3, criterion: "car-brand" },
        { value: "yamaha", count: 2, criterion: "moto-brand" },
      ],
      fuels: [
        { value: "diesel", count: 5 },
        { value: "essence", count: 2 },
      ],
      gearboxes: [
        { value: "manuelle", count: 6 },
        { value: "automatique", count: 1 },
      ],
      services: { tradeIn: 3, financing: 2, warranty: 3 },
      price: { min: 45_000, max: 260_000 },
    });
  });

  it("is null for a shop without vehicles, and has no price range without priced listings", () => {
    expect(toDealerStock(result(0), result(0), result(0))).toBeNull();
    expect(toDealerStock(result(2, { subcategoryId: { voitures: 2 } }), result(0), result(0))?.price).toBeNull();
  });
});

function render(stock: Stock) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr}>
      <DealerStock stock={stock} shop="abcdefghjk" />
    </NextIntlClientProvider>,
  );
}

const decode = (html: string) => html.replace(/&amp;/g, "&");

describe("DealerStock", () => {
  const stock = toDealerStock(result(9, facets), result(9, undefined, 45_000), result(9, undefined, 260_000))!;

  it("shows the count, the price range and the declared services with the note", () => {
    const html = render(stock);
    expect(html).toContain("9 véhicules en vente");
    expect(html).toContain(`de ${formatPrice(45_000, "fr")} à ${formatPrice(260_000, "fr")}`);
    expect(html).toContain(fr.Storefront.dealer.services.tradeIn);
    expect(html).toContain(fr.Storefront.dealer.services.financing);
    expect(html).toContain(fr.Storefront.dealer.servicesNote.slice(0, 40));
  });

  it("links every chip to the search narrowed to the shop", () => {
    const html = decode(render(stock));
    expect(html).toContain('href="/fr/recherche?categorie=vehicules&boutique=abcdefghjk"');
    expect(html).toMatch(/href="\/fr\/recherche\?[^"]*boutique=abcdefghjk[^"]*f-car-brand=dacia/);
    expect(html).toMatch(/href="\/fr\/recherche\?[^"]*f-moto-brand=yamaha/);
    expect(html).toMatch(/href="\/fr\/recherche\?[^"]*f-fuel=diesel/);
    expect(html).toContain("Dacia");
    expect(html).toContain("Motos & scooters");
  });

  it("caps the brands and counts the others, and hides empty services", () => {
    const brands = Array.from({ length: DEALER_BRANDS_MAX + 2 }, (_, index) => ({ value: `b${index}`, count: 1, criterion: "car-brand" as const }));
    const html = render({ ...stock, brands, services: { tradeIn: 0, financing: 0, warranty: 0 } });
    expect(html).toContain("2 autres marques");
    expect(html).not.toContain(fr.Storefront.dealer.services.tradeIn);
  });
});
