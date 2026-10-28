import { describe, expect, it } from "vitest";
import { toSearchCard } from "@/lib/search/cards";
import type { CardDocument } from "@/lib/search/types";

// Engine hit -> results card (design D22): whitelisted fields, nulls for absent values, the
// "Sponsorisé" mention only for a running boost in an À la Une slot.

const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function doc(overrides: Partial<CardDocument> = {}): CardDocument {
  return {
    id: "abcd2345",
    slugId: "velo-de-ville-abcd2345",
    title: "Vélo de ville",
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    citySlug: "casablanca",
    photo: { id: "ph1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    photoCount: 3,
    sellerType: "individual",
    sortAt: NOW.getTime() - HOUR,
    isBumped: false,
    ...overrides,
  };
}

describe("toSearchCard", () => {
  it("maps every card field", () => {
    expect(toSearchCard(doc(), NOW)).toEqual({
      id: "abcd2345",
      slugId: "velo-de-ville-abcd2345",
      title: "Vélo de ville",
      subcategoryId: "velos",
      price: 1500,
      priceNegotiable: true,
      isDonation: false,
      citySlug: "casablanca",
      photo: { id: "ph1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      photoCount: 3,
      sellerType: "individual",
      sortAt: "2026-10-16T11:00:00.000Z",
      bumped: false,
      featured: false,
    });
  });

  it("carries a real-estate card's surface, rooms, bedrooms and exclusive mandate", () => {
    const flat = toSearchCard(doc({ subcategoryId: "vente", a_surface: 95, a_rooms: 5, a_bedrooms: 3, a_mandate: "exclusif" }), NOW);
    expect(flat.facts).toEqual({ facts: [{ id: "surface", value: 95 }, { id: "rooms", value: 5 }, { id: "bedrooms", value: 3 }], exclusive: true });
    expect(toSearchCard(doc({ subcategoryId: "location", a_surface: 60, a_mandate: "simple" }), NOW).facts).toEqual({ facts: [{ id: "surface", value: 60 }], exclusive: false });
    // A field the subcategory does not declare, or of the wrong type, is not a fact.
    expect(toSearchCard(doc({ subcategoryId: "colocation", a_surface: 20, a_mandate: "exclusif" }), NOW)).not.toHaveProperty("facts");
    expect(toSearchCard(doc({ subcategoryId: "vente", a_surface: "95" }), NOW)).not.toHaveProperty("facts");
  });

  it("answers null for a missing price, photo, city or subcategory", () => {
    const { price: _price, photo: _photo, ...rest } = doc();
    const card = toSearchCard({ ...rest, citySlug: "", subcategoryId: "", isDonation: true, priceNegotiable: false, photoCount: 0 }, NOW);
    expect(card).toMatchObject({ price: null, photo: null, citySlug: null, subcategoryId: null, isDonation: true, photoCount: 0 });
  });

  it("drops fields the index may carry beyond the card", () => {
    const extra = { ...doc(), description: "long text", sellerPublicId: "abcdefghjk", photo: { id: "p", w: 1, h: 1, blurhash: "x", hash: "secret" } } as CardDocument;
    const card = toSearchCard(extra, NOW);
    expect(card).not.toHaveProperty("description");
    expect(card).not.toHaveProperty("sellerPublicId");
    expect(card.photo).toEqual({ id: "p", w: 1, h: 1, blurhash: "x" });
  });

  it("marks an example listing", () => {
    expect(toSearchCard(doc({ isExample: true }), NOW)?.example).toBe(true);
    expect(toSearchCard(doc(), NOW)).not.toHaveProperty("example");
  });

  it("marks bumped listings and pro sellers", () => {
    expect(toSearchCard(doc({ isBumped: true, sellerType: "pro" }), NOW)).toMatchObject({ bumped: true, sellerType: "pro", featured: false });
  });

  it("shows the À la Une mention only in a slot and while the boost runs", () => {
    const running = doc({ featuredUntil: NOW.getTime() + HOUR });
    expect(toSearchCard(running, NOW, true).featured).toBe(true);
    expect(toSearchCard(running, NOW).featured).toBe(false);
    expect(toSearchCard(doc({ featuredUntil: NOW.getTime() - 1 }), NOW, true).featured).toBe(false);
    expect(toSearchCard(doc(), NOW, true).featured).toBe(false);
  });

  it("never throws on a malformed date", () => {
    expect(toSearchCard(doc({ sortAt: Number.NaN }), NOW).sortAt).toBe(NOW.toISOString());
  });
});
