import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingStatus } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import type * as Quota from "@/lib/quota";

// Views of the public pages (lot D2): what the listing page and the profile render, and only that
// (no uid, no moderation data, no contact data beyond the two booleans), plus the seller lookup and
// the profile's listing count. Firestore is mocked.

const repo = vi.hoisted(() => ({
  getListing: vi.fn<(id: string) => Promise<ListingRecord | null>>(),
  listPublishedByOwner: vi.fn<(uid: string, limit?: number) => Promise<ListingRecord[]>>(),
  findUserByPublicId: vi.fn<(publicId: string) => Promise<UserRecord | null>>(),
  getUserRecord: vi.fn<(uid: string) => Promise<UserRecord | null>>(),
  count: vi.fn<() => number>(),
  where: vi.fn(),
  consume: vi.fn(),
  firstDegraded: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/db/repositories/listings", () => ({ getListing: repo.getListing, listPublishedByOwner: repo.listPublishedByOwner }));
vi.mock("@/lib/db/repositories/profiles", () => ({ findUserByPublicId: repo.findUserByPublicId, getUserRecord: repo.getUserRecord }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), consume: repo.consume, firstDegraded: repo.firstDegraded }));
vi.mock("@/lib/firebase/admin", () => {
  const query = {
    where: (...args: unknown[]) => {
      repo.where(...args);
      return query;
    },
    count: () => ({ get: async () => ({ data: () => ({ count: repo.count() }) }) }),
  };
  return { db: () => ({ collection: () => query }) };
});

const { getPublicProfile, getSeller, listingPath, profilePath, toPublicCard, toPublicListing } = await import("@/lib/listings/public");

const NOW = new Date("2026-10-16T10:00:00.000Z");
const ID = "abcd2345";

function record(status: ListingStatus = "published", overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: ID,
    ownerUid: "uid-secret-1",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status,
    slugId: `velo-de-ville-casablanca-${ID}`,
    title: "Vélo de ville",
    description: "Un vélo de ville en bon état, révisé.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [{ id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" }],
    contact: { messaging: true, showPhone: true, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 12, flags: ["new_account"], openReports: 0 },
    adsEligible: true,
    publishedAt: NOW,
    expiresAt: new Date("2026-12-15T10:00:00.000Z"),
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 3,
    ...overrides,
  };
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    uid: "uid-secret-1",
    publicId: "abcdefghjk",
    displayName: "Salma",
    type: "individual",
    citySlug: "casablanca",
    badges: { emailVerified: true, phoneVerified: true, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.count.mockReturnValue(7);
  repo.firstDegraded.mockResolvedValue(null);
});

describe("toPublicListing", () => {
  it("keeps what the page shows and drops the uid, moderation, geo point, photo hashes and legal fields", () => {
    const view = toPublicListing(record(), "published", `velo-de-ville-casablanca-${ID}`);
    expect(view).toEqual({
      id: ID,
      slugId: `velo-de-ville-casablanca-${ID}`,
      state: "published",
      title: "Vélo de ville",
      description: "Un vélo de ville en bon état, révisé.",
      categoryId: "vehicules",
      subcategoryId: "velos",
      attributes: { "bike-type": "ville" },
      condition: "good",
      price: 1500,
      priceNegotiable: true,
      isDonation: false,
      location: { regionCode: "06", citySlug: "casablanca", district: null },
      photos: [{ id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
      contact: { showPhone: true, whatsapp: false },
      seller: { publicId: "abcdefghjk", name: "Salma", type: "individual" },
      example: false,
      publishedAt: NOW.toISOString(),
      sortAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const text = JSON.stringify(view);
    for (const secret of ["uid-secret-1", "moderation", "new_account", "33.57", "0123456789abcdef", "legalHold", "expiresAt", "adsEligible"]) expect(text, secret).not.toContain(secret);
  });

  it("refuses a document without the fields every published listing has (404, not half a page)", () => {
    expect(toPublicListing(record("published", { location: undefined }), "published", "x-abcd2345")).toBeNull();
    expect(toPublicListing(record("published", { subcategoryId: undefined }), "published", "x-abcd2345")).toBeNull();
  });
});

describe("toPublicCard", () => {
  it("takes the first photo, the photo count and the date to show", () => {
    expect(toPublicCard(record())).toEqual({
      id: ID,
      slugId: `velo-de-ville-casablanca-${ID}`,
      title: "Vélo de ville",
      subcategoryId: "velos",
      price: 1500,
      priceNegotiable: true,
      isDonation: false,
      citySlug: "casablanca",
      photo: { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      photoCount: 1,
      sellerType: "individual",
      sortAt: NOW.toISOString(),
    });
    expect(toPublicCard(record("published", { slugId: undefined }))).toBeNull();
  });
});

describe("paths", () => {
  it("prefixes the locale", () => {
    expect(listingPath("ar", `velo-${ID}`)).toBe(`/ar/annonce/velo-${ID}`);
    expect(profilePath("fr", "abcdefghjk")).toBe("/fr/profil/abcdefghjk");
  });
});

describe("getSeller", () => {
  it("returns the public seller card with the count of published listings", async () => {
    repo.getUserRecord.mockResolvedValue(user());
    expect(await getSeller("uid-secret-1")).toEqual({
      publicId: "abcdefghjk",
      displayName: "Salma",
      sellerType: "individual",
      memberSince: "2025-10",
      badges: { emailVerified: true, phoneVerified: true, proCertified: false },
      citySlug: "casablanca",
      publishedCount: 7,
      bio: null,
      bannerKey: "zellige",
    });
    expect(repo.where).toHaveBeenCalledWith("ownerUid", "==", "uid-secret-1");
    expect(repo.where).toHaveBeenCalledWith("status", "==", "published");
    expect(repo.consume).toHaveBeenCalledWith("firestore.reads", 1);
  });

  it("bills the count like Firestore: one read per 1 000 index entries", async () => {
    repo.getUserRecord.mockResolvedValue(user());
    repo.count.mockReturnValue(2_500);
    expect((await getSeller("uid-secret-1"))?.publishedCount).toBe(2_500);
    expect(repo.consume).toHaveBeenCalledWith("firestore.reads", 3);
  });

  it("hides closed, banned and unactivated accounts; a suspended one counts no listing", async () => {
    repo.getUserRecord.mockResolvedValue(null);
    expect(await getSeller("uid-secret-1")).toBeNull();
    for (const overrides of [{ status: "closed" }, { status: "banned" }, { activation: "pending" }] as const) {
      repo.getUserRecord.mockResolvedValue(user(overrides));
      expect(await getSeller("uid-secret-1")).toBeNull();
    }
    repo.getUserRecord.mockResolvedValue(user({ status: "suspended" }));
    expect((await getSeller("uid-secret-1"))?.publishedCount).toBe(0);
    expect(repo.count).not.toHaveBeenCalled();
  });
});

describe("getPublicProfile", () => {
  it("returns the header and the cards; a short page is its own count", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue([record()]);
    const profile = await getPublicProfile("abcdefghjk", 24);
    expect(profile).toMatchObject({ publicId: "abcdefghjk", displayName: "Salma", memberSince: "2025-10", citySlug: "casablanca", publishedCount: 1 });
    expect(profile?.listings).toHaveLength(1);
    expect(JSON.stringify(profile)).not.toContain("uid-secret-1");
    expect(repo.listPublishedByOwner).toHaveBeenCalledWith("uid-secret-1", 24);
    expect(repo.count).not.toHaveBeenCalled();
  });

  it("counts beyond a full page", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue([record(), record("published", { id: "bcde3456", slugId: `autre-bcde3456` })]);
    repo.count.mockReturnValue(31);
    expect((await getPublicProfile("abcdefghjk", 2))?.publishedCount).toBe(31);
  });

  it("is null for unknown and hidden accounts, empty for a suspended one", async () => {
    repo.findUserByPublicId.mockResolvedValue(null);
    expect(await getPublicProfile("abcdefghjk")).toBeNull();
    repo.findUserByPublicId.mockResolvedValue(user({ status: "banned" }));
    expect(await getPublicProfile("abcdefghjk")).toBeNull();
    repo.findUserByPublicId.mockResolvedValue(user({ status: "suspended" }));
    expect(await getPublicProfile("abcdefghjk")).toMatchObject({ listings: [], publishedCount: 0 });
    expect(repo.listPublishedByOwner).not.toHaveBeenCalled();
  });

  it("throws before any read once Firestore reads are degraded (ISR keeps the last page)", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.firstDegraded.mockResolvedValue("firestore.reads");
    await expect(getPublicProfile("abcdefghjk")).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    expect(repo.firstDegraded).toHaveBeenCalledWith(["firestore.reads"]);
    expect(repo.findUserByPublicId).not.toHaveBeenCalled();
    expect(repo.consume).not.toHaveBeenCalled();
  });
});
