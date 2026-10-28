import { describe, expect, it } from "vitest";
import type { ListingDoc } from "@/lib/db/schemas";
import { screen, sellerFacts } from "@/lib/listings/screening";

// Adapter between a listing document and the moderation core: the seller facts (a reopened
// listing's own rejection counts) and the fields handed to the screen (the district included).

const NOW = new Date("2026-10-16T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function listing(overrides: Partial<ListingDoc> = {}): ListingDoc {
  return {
    ownerUid: "uid-screening",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcd2345",
    status: "draft",
    title: "Vélo de ville Peugeot en bon état",
    description: "Vélo de ville 28 pouces, 6 vitesses, révisé récemment, deux pneus neufs. Remise en main propre.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville", brand: "Peugeot" },
    condition: "good",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: false,
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  } as ListingDoc;
}

const seller = { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: false, previousRejections: 0 };

describe("sellerFacts", () => {
  it("counts the other rejected listings, plus the listing itself when a moderator rejected it", () => {
    const others = [
      { status: "rejected" as const, createdAt: new Date(NOW.getTime() - 10 * DAY_MS) },
      { status: "published" as const, createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) },
    ];
    const base = { accountCreatedAt: new Date(NOW.getTime() - 40 * DAY_MS), phoneVerified: true, others, now: NOW };
    expect(sellerFacts(base)).toEqual({ accountAgeDays: 40, listingsLast24h: 1, phoneVerified: true, previousRejections: 1, sanitaryNumbers: [] });
    expect(sellerFacts({ ...base, selfRejected: true }).previousRejections).toBe(2);
    expect(sellerFacts({ ...base, others: [], selfRejected: false }).previousRejections).toBe(0);
  });
});

describe("screen", () => {
  it("hands the district to the core: a phone number there blocks, a plain district passes", async () => {
    const located = (district: string) => listing({ location: { regionCode: "06", citySlug: "casablanca", district, geo: { lat: 33.57, lng: -7.59 } } });
    const blocked = await screen({ listing: located("Maarif 06 12 34 56 78"), uploads: [], seller, others: [] });
    expect(blocked.blockers).toEqual([{ path: "location.district", code: "phone_in_text" }]);
    const clean = await screen({ listing: located("Maarif"), uploads: [], seller, others: [] });
    expect(clean).toMatchObject({ state: "auto_ok", blockers: [], flags: [] });
    expect((await screen({ listing: listing(), uploads: [], seller, others: [] })).blockers).toEqual([]);
  });

  it("scores the previous rejections the facts carry", async () => {
    const result = await screen({ listing: listing(), uploads: [], seller: { ...seller, previousRejections: 1 }, others: [] });
    expect(result).toMatchObject({ state: "auto_ok", score: 10 });
    expect(result.evidence).toContain("1 previous rejection(s)");
  });
});
