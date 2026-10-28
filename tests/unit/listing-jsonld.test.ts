import { describe, expect, it } from "vitest";
import { JSON_LD_DESCRIPTION_MAX, listingJsonLd, serializeJsonLd } from "@/lib/listings/jsonld";
import type { PublicListing } from "@/lib/listings/public";

// schema.org data of the listing page: Product + Offer from what the page shows, never the phone,
// never the seller, and a serialization that cannot close its <script> element.

const URL_ = "https://joutiya.ma/fr/annonce/velo-de-ville-casablanca-abcd2345";

function listing(overrides: Partial<PublicListing> = {}): PublicListing {
  return {
    id: "abcd2345",
    slugId: "velo-de-ville-casablanca-abcd2345",
    state: "published",
    title: "Vélo de ville Peugeot",
    description: "Vélo de ville 28 pouces, 6 vitesses.\nRévisé récemment.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", district: "Maârif" },
    photos: [{ id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
    contact: { showPhone: true, whatsapp: true },
    seller: { publicId: "abcdefghjk", name: "Salma Testeuse", type: "individual" },
    example: false,
    publishedAt: "2026-10-12T10:00:00.000Z",
    sortAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

const build = (overrides: Partial<PublicListing> = {}) =>
  listingJsonLd({ listing: listing(overrides), url: URL_, images: ["https://media.joutiya.ma/listings/abcd2345/photo0001-l.webp"], categoryName: "Vélos", cityName: "Casablanca", regionName: "Casablanca-Settat" });

describe("listingJsonLd", () => {
  it("describes the item as a Product with an Offer in MAD", () => {
    const data = build();
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Vélo de ville Peugeot",
      sku: "abcd2345",
      url: URL_,
      category: "Vélos",
      image: ["https://media.joutiya.ma/listings/abcd2345/photo0001-l.webp"],
      offers: {
        "@type": "Offer",
        price: "1500",
        priceCurrency: "MAD",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/UsedCondition",
        availableAtOrFrom: { "@type": "Place", address: { addressLocality: "Casablanca", addressRegion: "Casablanca-Settat", addressCountry: "MA" } },
      },
    });
    expect((data as { description: string }).description).toBe("Vélo de ville 28 pouces, 6 vitesses. Révisé récemment.");
  });

  it("never carries the phone, the seller or any account identifier", () => {
    const text = JSON.stringify(build());
    for (const forbidden of ["telephone", "phone", "seller", "Salma", "abcdefghjk", "ownerUid", "e164", "whatsapp", "Maârif"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("maps the public states to availabilities and the conditions to schema.org conditions", () => {
    const offer = (overrides: Partial<PublicListing>) => (build(overrides).offers as Record<string, string>) ?? {};
    expect(offer({ state: "sold" }).availability).toBe("https://schema.org/SoldOut");
    expect(offer({ state: "paused" }).availability).toBe("https://schema.org/OutOfStock");
    expect(offer({ state: "expired" }).availability).toBe("https://schema.org/Discontinued");
    expect(offer({ condition: "new_tagged" }).itemCondition).toBe("https://schema.org/NewCondition");
    expect(offer({ condition: "for_parts" }).itemCondition).toBe("https://schema.org/DamagedCondition");
    expect(offer({ condition: null }).itemCondition).toBeUndefined();
  });

  it("prices a donation at 0 and publishes no Offer without an amount", () => {
    expect((build({ isDonation: true, price: null }).offers as Record<string, string>).price).toBe("0");
    expect(build({ price: null }).offers).toBeUndefined();
  });

  it("caps the description", () => {
    const data = build({ description: "mot ".repeat(800) });
    const description = (data as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(JSON_LD_DESCRIPTION_MAX);
    expect(description.endsWith("…")).toBe(true);
  });
});

describe("serializeJsonLd", () => {
  it("cannot close the script element or open a comment", () => {
    const text = serializeJsonLd({ name: "</script><script>alert(1)</script><!-- & \u2028" });
    expect(text).not.toMatch(/[<>&\u2028]/);
    expect(text).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(text)).toEqual({ name: "</script><script>alert(1)</script><!-- & \u2028" });
  });
});
