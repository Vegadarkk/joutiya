import { describe, expect, it } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { isIndexable, toSearchDocument, truncateText } from "@/lib/search/document";
import { SEARCH_DESCRIPTION_MAX, SITEMAP_SHARDS, sitemapShardOf } from "@/lib/search/types";

// Listing -> search document (design D4, D9): what is indexed (fr + ar labels, criteria, rounded
// geo, epoch dates) and what never is (owner, pro id, contact settings, exact position).

const NOW = new Date("2026-10-16T10:00:00Z");

function listing(overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: "abcdefgh",
    ownerUid: "owner-secret-uid",
    proId: "pro-secret-id",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status: "published",
    slugId: "velo-de-ville-casablanca-abcdefgh",
    title: "  Vélo de ville Peugeot ",
    description: "Vélo de ville 28 pouces, révisé.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville", brand: "Peugeot" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.59924, lng: -7.61987 } },
    photos: [
      { id: "photo-1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" },
      { id: "photo-2", w: 1200, h: 1600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    ],
    contact: { messaging: true, showPhone: true, whatsapp: true },
    boosts: {},
    sortAt: new Date("2026-10-15T08:00:00Z"),
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 3, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: new Date("2026-10-15T08:00:00Z"),
    expiresAt: new Date("2026-12-14T08:00:00Z"),
    legalHold: [],
    createdAt: new Date("2026-10-14T08:00:00Z"),
    updatedAt: new Date("2026-10-15T09:00:00Z"),
    version: 7,
    ...overrides,
  } as ListingRecord;
}

describe("isIndexable", () => {
  it("accepts a published, public, complete listing", () => {
    expect(isIndexable(listing())).toBe(true);
    expect(isIndexable(listing({ moderation: { state: "human_ok", score: 40, flags: [], openReports: 0 } }))).toBe(true);
  });

  it.each([
    ["paused", { status: "paused" }],
    ["sold", { status: "sold" }],
    ["pending review", { status: "pending_review" }],
    ["needs_review", { moderation: { state: "needs_review", score: 70, flags: [], openReports: 0 } }],
    ["auto_rejected", { moderation: { state: "auto_rejected", score: 95, flags: [], openReports: 0 } }],
    ["hidden by a report", { moderation: { state: "auto_ok", score: 3, flags: [], openReports: 3, hiddenBy: { reportId: "r1", signal: "multi", at: NOW } } }],
    ["without slugId", { slugId: undefined }],
    ["without location", { location: undefined }],
    ["without subcategory", { subcategoryId: undefined }],
  ] as const)("refuses a listing %s", (_label, overrides) => {
    const record = listing(overrides as Partial<ListingRecord>);
    expect(isIndexable(record)).toBe(false);
    expect(toSearchDocument(record, NOW)).toBeNull();
  });

  it("works on the reconciliation projection", () => {
    expect(isIndexable({ status: "published", slugId: "x-abcdefgh", categoryId: "vehicules", subcategoryId: "velos", location: { regionCode: "06", citySlug: "casablanca" }, moderation: { state: "auto_ok" } })).toBe(true);
    expect(isIndexable({ status: "published", slugId: "x-abcdefgh", categoryId: "vehicules", subcategoryId: "velos", location: { regionCode: "06", citySlug: "casablanca" }, moderation: { state: "auto_ok", hiddenBy: { reportId: "r" } } })).toBe(false);
  });
});

describe("toSearchDocument", () => {
  it("maps a listing to its public document", () => {
    const doc = toSearchDocument(listing(), NOW)!;
    expect(doc).toEqual({
      id: "abcdefgh",
      slugId: "velo-de-ville-casablanca-abcdefgh",
      title: "Vélo de ville Peugeot",
      description: "Vélo de ville 28 pouces, révisé.",
      categoryText: "Véhicules مركبات Vélos دراجات هوائية",
      placeText: "Casablanca الدار البيضاء Casablanca-Settat الدار البيضاء-سطات",
      attrsText: "Ville دراجة مدينية Peugeot Bon état حالة جيدة",
      categoryId: "vehicules",
      subcategoryId: "velos",
      regionCode: "06",
      citySlug: "casablanca",
      sellerType: "individual",
      sellerPublicId: "abcdefghjk",
      price: 1500,
      priceNegotiable: true,
      isDonation: false,
      condition: "good",
      hasPhoto: true,
      photo: { id: "photo-1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      photoCount: 2,
      sortAt: Date.parse("2026-10-15T08:00:00Z"),
      updatedAt: Date.parse("2026-10-15T09:00:00Z"),
      sitemapShard: sitemapShardOf("abcdefgh"),
      isBumped: false,
      _geo: { lat: 33.6, lng: -7.62 },
      version: 7,
      a_bike_type: "ville",
    });
  });

  it("never carries the owner, the pro id, the contact settings or the exact position", () => {
    const text = JSON.stringify(toSearchDocument(listing(), NOW));
    for (const secret of ["owner-secret-uid", "pro-secret-id", "ownerUid", "proId", "contact", "showPhone", "33.59924", "-7.61987", "0123456789abcdef"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("indexes options, flags and numbers of the subcategory's criteria", () => {
    const doc = toSearchDocument(
      listing({
        categoryId: "immobilier",
        subcategoryId: "location",
        attributes: { "property-type": "appartement", surface: 85, furnished: true, amenities: ["parking", "ascenseur"], availability: "immediate", "car-brand": "dacia" },
        condition: undefined,
        location: { regionCode: "06", citySlug: "casablanca", district: "Maârif  Extension", geo: { lat: 33.58, lng: -7.63 } },
      }),
      NOW,
    )!;
    expect(doc).toMatchObject({ a_property_type: "appartement", a_surface: 85, a_furnished: true, a_amenities: ["parking", "ascenseur"], a_availability: "immediate", district: "maarif extension" });
    // A criterion the subcategory does not declare is ignored.
    expect(doc).not.toHaveProperty("a_car_brand");
    expect(doc.attrsText).toContain("Meublé مفروش");
    expect(doc.attrsText).toContain("Parking");
    expect(doc.attrsText).toContain("مصعد");
    expect(doc.attrsText).not.toContain("85");
    expect(doc.placeText).toContain("Maârif Extension");
    expect(doc.categoryText).toBe("Immobilier عقارات Location كراء");
  });

  it("keeps an `autre` option filterable but out of the text", () => {
    const doc = toSearchDocument(listing({ attributes: { "bike-type": "autre" } }), NOW)!;
    expect(doc.a_bike_type).toBe("autre");
    expect(doc.attrsText).not.toMatch(/autre/i);
  });

  it("omits the price of a donation or of a price to discuss", () => {
    expect(toSearchDocument(listing({ isDonation: true, price: null }), NOW)).not.toHaveProperty("price");
    expect(toSearchDocument(listing({ price: null }), NOW)).not.toHaveProperty("price");
    expect(toSearchDocument(listing({ isDonation: true, price: 0 }), NOW)).not.toHaveProperty("price");
  });

  it("flags a bumped listing and keeps À la Une only while it runs", () => {
    const running = new Date(NOW.getTime() + 3_600_000);
    expect(toSearchDocument(listing({ sortSource: "bump" }), NOW)?.isBumped).toBe(true);
    expect(toSearchDocument(listing({ boosts: { featuredUntil: running } }), NOW)?.featuredUntil).toBe(running.getTime());
    expect(toSearchDocument(listing({ boosts: { featuredUntil: new Date(NOW.getTime() - 1) } }), NOW)).not.toHaveProperty("featuredUntil");
  });

  it("marks an example listing and keeps it out of every sitemap shard", () => {
    const doc = toSearchDocument(listing({ example: true }), NOW)!;
    expect(doc.isExample).toBe(true);
    expect(doc.sitemapShard).toBe(SITEMAP_SHARDS);
    expect(toSearchDocument(listing(), NOW)).not.toHaveProperty("isExample");
  });

  it("indexes a listing without photo", () => {
    const doc = toSearchDocument(listing({ photos: [] }), NOW)!;
    expect(doc).toMatchObject({ hasPhoto: false, photoCount: 0 });
    expect(doc).not.toHaveProperty("photo");
  });

  it("folds Arabic-Indic digits in the indexed text, keeps the displayed title as written", () => {
    const doc = toSearchDocument(listing({ title: "سيارة ٢٠١٩", description: "موديل ٢٠١٩ بحالة جيدة" }), NOW)!;
    expect(doc.title).toBe("سيارة ٢٠١٩");
    expect(doc.attrsText).toContain("سيارة 2019");
    expect(doc.description).toBe("موديل 2019 بحالة جيدة");
    expect(toSearchDocument(listing({ title: "Golf 7 2019" }), NOW)!.attrsText).not.toContain("Golf 7 2019");
  });

  it("folds Arabic-Indic digits of free-text criteria and of the district", () => {
    const doc = toSearchDocument(
      listing({
        title: "بيجو للبيع",
        categoryId: "vehicules",
        subcategoryId: "voitures",
        attributes: { "car-brand": "peugeot", model: "٢٠٨", year: 2019 },
        location: { regionCode: "06", citySlug: "casablanca", district: "حي ٢٠ غشت", geo: { lat: 33.58, lng: -7.63 } },
      }),
      NOW,
    )!;
    expect(doc.attrsText).toContain("208");
    expect(doc.attrsText).not.toMatch(/[٠-٩]/);
    expect(doc.placeText).toContain("حي 20 غشت");
    expect(doc.title).toBe("بيجو للبيع");
  });

  it("truncates the description", () => {
    const doc = toSearchDocument(listing({ description: `${"mot ".repeat(1_000)}fin` }), NOW)!;
    expect(doc.description.length).toBeLessThanOrEqual(SEARCH_DESCRIPTION_MAX);
    expect(doc.description.endsWith("mot")).toBe(true);
  });
});

describe("truncateText", () => {
  it("keeps short texts and cuts on a word boundary", () => {
    expect(truncateText("  court  ", 10)).toBe("court");
    expect(truncateText("un deux trois quatre", 12)).toBe("un deux");
  });

  it("cuts a single long word at the limit, never inside a surrogate pair", () => {
    expect(truncateText("a".repeat(200), 100)).toHaveLength(100);
    const emoji = `${"a".repeat(99)}😀b`;
    expect(truncateText(emoji, 100)).toBe("a".repeat(99));
  });
});
