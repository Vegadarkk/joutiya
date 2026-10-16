import { describe, expect, it } from "vitest";
import { ALERT_LISTINGS_PER_SEARCH, digestDay, digestIdempotencyKey, digestSections, newestSortAt, type SearchNews } from "@/lib/alerts/digest";
import type { SearchCard } from "@/lib/search/types";

// D19: the pure parts of the alert digest (sections, cursor, daily idempotency key).

// Same contract as siteUrl in @/lib/mail/recipients: one leading slash at most.
const url = (locale: string, path: string) => `https://joutiya.ma/${locale}/${path.replace(/^\//, "")}`;

function card(id: string, sortAt: string): SearchCard {
  return {
    id,
    slugId: `velo-${id}`,
    title: `Vélo ${id}`,
    subcategoryId: "velos",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    citySlug: "casablanca",
    photo: null,
    photoCount: 0,
    sellerType: "individual",
    sortAt,
    bumped: false,
    featured: false,
  };
}

function news(searchId: string, createdAt: string, hits: SearchCard[], total = hits.length): SearchNews {
  return { searchId, name: `Recherche ${searchId}`, params: { subcategory: "velos", category: "vehicules", sort: "price_asc" }, createdAt: new Date(createdAt), total, hits };
}

describe("digest", () => {
  it("takes the newest sortAt of the hits as the next cursor", () => {
    expect(newestSortAt([card("a", "2026-10-15T10:00:00.000Z"), card("b", "2026-10-16T06:59:59.123Z")])).toBe(Date.parse("2026-10-16T06:59:59.123Z"));
    expect(newestSortAt([])).toBe(0);
  });

  it("keys one digest per account and UTC day", () => {
    expect(digestDay(new Date("2026-10-16T07:00:00Z"))).toBe("20261016");
    expect(digestIdempotencyKey("uid-1", new Date("2026-10-16T23:59:59Z"))).toBe("savedSearchAlert-uid-1-20261016");
  });

  it("orders sections like the account page, links the newest-first results and caps the listings", () => {
    const hits = Array.from({ length: 7 }, (_, index) => card(`id${index}`, `2026-10-16T0${index}:00:00.000Z`));
    const sections = digestSections(
      [news("old", "2026-09-01T00:00:00Z", hits.slice(0, 2)), news("new", "2026-10-01T00:00:00Z", hits, 12), news("empty", "2026-10-02T00:00:00Z", [], 0)],
      "ar",
      url,
    );
    expect(sections.map((section) => section.name)).toEqual(["Recherche new", "Recherche old"]);
    expect(sections[0]?.total).toBe(12);
    expect(sections[0]?.listings).toHaveLength(ALERT_LISTINGS_PER_SEARCH);
    expect(sections[0]?.listings[0]).toEqual({ title: "Vélo id0", url: "https://joutiya.ma/ar/annonce/velo-id0", price: 1500, isDonation: false, citySlug: "casablanca" });
    // The saved sort gives way to "recent" (the default without words: no tri parameter).
    expect(sections[0]?.url).toBe("https://joutiya.ma/ar/recherche?categorie=vehicules&sous-categorie=velos");
  });
});
