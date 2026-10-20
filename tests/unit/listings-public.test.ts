import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingStatus } from "@/lib/contracts/listings";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import type * as Quota from "@/lib/quota";

// Public reads (design §4 public.ts): slug parsing -> redirect decision, which statuses render,
// profile by publicId. Repositories mocked: no Firestore here.

const repo = vi.hoisted(() => ({
  getListing: vi.fn<(id: string) => Promise<ListingRecord | null>>(),
  listPublishedByOwner: vi.fn<(uid: string, limit?: number) => Promise<ListingRecord[]>>(),
  findUserByPublicId: vi.fn<(publicId: string) => Promise<UserRecord | null>>(),
  getUserRecord: vi.fn<(uid: string) => Promise<UserRecord | null>>(),
  getProProfile: vi.fn<(proId: string) => Promise<ProProfileRecord | null>>(),
  firstDegraded: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("@/lib/db/repositories/listings", () => ({ getListing: repo.getListing, listPublishedByOwner: repo.listPublishedByOwner }));
vi.mock("@/lib/db/repositories/profiles", () => ({ findUserByPublicId: repo.findUserByPublicId, getUserRecord: repo.getUserRecord }));
vi.mock("@/lib/db/repositories/pro-profiles", () => ({ getProProfile: repo.getProProfile }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: repo.firstDegraded }));

const { getPublishedBySlugId, getProfile, getPublicStorefront, memberSince, parseStorefrontSegment, PUBLIC_STATES } = await import("@/lib/listings/public");

const NOW = new Date("2026-10-16T10:00:00.000Z");
const ID = "abcd2345";

/** `slugId: null` builds a record without a stored slug (a passed `undefined` would take the default). */
function record(status: ListingStatus, slugId: string | null = `velo-de-ville-casablanca-${ID}`): ListingRecord {
  return {
    id: ID,
    ownerUid: "uid-1",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status,
    ...(slugId === null ? {} : { slugId }),
    title: "Vélo de ville",
    description: "Un vélo de ville en bon état, révisé.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: {},
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 2,
  };
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    uid: "uid-1",
    publicId: "abcdefghjk",
    displayName: "Salma",
    type: "individual",
    badges: { emailVerified: true, phoneVerified: true, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2026-03-05T12:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  repo.getListing.mockReset();
  repo.listPublishedByOwner.mockReset();
  repo.findUserByPublicId.mockReset();
  repo.getUserRecord.mockReset();
  repo.getProProfile.mockReset();
  repo.firstDegraded.mockReset();
  repo.firstDegraded.mockResolvedValue(null);
});

describe("getPublishedBySlugId", () => {
  it("returns the listing without redirect on the canonical segment", async () => {
    repo.getListing.mockResolvedValue(record("published"));
    const result = await getPublishedBySlugId(`velo-de-ville-casablanca-${ID}`);
    expect(result).toMatchObject({ canonicalSlugId: `velo-de-ville-casablanca-${ID}`, redirect: false, state: "published" });
    expect(result?.listing.id).toBe(ID);
    expect(repo.getListing).toHaveBeenCalledWith(ID);
  });

  it("asks for a 301 on a stale slug or a bare id", async () => {
    repo.getListing.mockResolvedValue(record("published"));
    expect(await getPublishedBySlugId(`ancien-titre-${ID}`)).toMatchObject({ redirect: true, canonicalSlugId: `velo-de-ville-casablanca-${ID}` });
    expect(await getPublishedBySlugId(ID)).toMatchObject({ redirect: true });
  });

  it("answers null for a malformed segment without touching Firestore", async () => {
    expect(await getPublishedBySlugId("velo-de-ville")).toBeNull();
    expect(await getPublishedBySlugId("velo_ABCD2345")).toBeNull();
    expect(await getPublishedBySlugId("velo-abcd0145")).toBeNull();
    expect(repo.getListing).not.toHaveBeenCalled();
  });

  it("answers null for a missing listing and for the never-public or gone statuses (D14: 404)", async () => {
    repo.getListing.mockResolvedValue(null);
    expect(await getPublishedBySlugId(`velo-${ID}`)).toBeNull();
    for (const status of ["draft", "pending_review", "rejected", "removed", "purged"] as const) {
      repo.getListing.mockResolvedValue(record(status));
      expect(await getPublishedBySlugId(`velo-${ID}`), status).toBeNull();
    }
  });

  it("keeps paused, sold and expired pages up with their state for the banner", async () => {
    expect(PUBLIC_STATES).toEqual(["published", "paused", "sold", "expired"]);
    for (const status of ["paused", "sold", "expired"] as const) {
      repo.getListing.mockResolvedValue(record(status));
      expect(await getPublishedBySlugId(`velo-de-ville-casablanca-${ID}`), status).toMatchObject({ state: status, redirect: false });
    }
  });

  it("rebuilds a canonical slug when the document has none", async () => {
    repo.getListing.mockResolvedValue(record("published", null));
    const result = await getPublishedBySlugId(ID);
    expect(result?.canonicalSlugId).toBe(`velo-de-ville-${ID}`);
    expect(result?.redirect).toBe(true);
  });

  it("throws before the read once Firestore reads are degraded (ISR keeps the last page); a malformed id stays a 404", async () => {
    repo.getListing.mockResolvedValue(record("published"));
    repo.firstDegraded.mockResolvedValue("firestore.reads");
    await expect(getPublishedBySlugId(`velo-de-ville-casablanca-${ID}`)).rejects.toMatchObject({ status: 503, code: "quota_exhausted" });
    expect(repo.firstDegraded).toHaveBeenCalledWith(["firestore.reads"]);
    expect(repo.getListing).not.toHaveBeenCalled();
    repo.firstDegraded.mockClear();
    expect(await getPublishedBySlugId("velo-de-ville")).toBeNull();
    expect(repo.firstDegraded).not.toHaveBeenCalled();
  });
});

describe("getProfile", () => {
  it("exposes the public fields only, the month of registration and the published listings", async () => {
    repo.findUserByPublicId.mockResolvedValue(user());
    repo.listPublishedByOwner.mockResolvedValue([record("published")]);
    const profile = await getProfile("abcdefghjk");
    expect(profile).toEqual({
      publicId: "abcdefghjk",
      displayName: "Salma",
      memberSince: "2026-03",
      badges: { emailVerified: true, phoneVerified: true, proCertified: false },
      sellerType: "individual",
      listings: [expect.objectContaining({ id: ID })],
    });
    expect(Object.keys(profile!)).not.toContain("uid");
    expect(repo.listPublishedByOwner).toHaveBeenCalledWith("uid-1", 24);
    expect(memberSince(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12");
  });

  it("hides closed, banned and never-activated accounts; a suspended one shows no listing", async () => {
    repo.findUserByPublicId.mockResolvedValue(null);
    expect(await getProfile("abcdefghjk")).toBeNull();
    for (const status of ["closed", "banned"] as const) {
      repo.findUserByPublicId.mockResolvedValue(user({ status }));
      expect(await getProfile("abcdefghjk"), status).toBeNull();
    }
    repo.findUserByPublicId.mockResolvedValue(user({ activation: "pending" }));
    expect(await getProfile("abcdefghjk")).toBeNull();
    repo.findUserByPublicId.mockResolvedValue(user({ status: "suspended" }));
    expect((await getProfile("abcdefghjk"))?.listings).toEqual([]);
    expect(repo.listPublishedByOwner).not.toHaveBeenCalled();
  });
});

describe("storefront", () => {
  const PRO = "shep2345";
  const shop = (overrides: Partial<ProProfileRecord> = {}) =>
    ({ proId: PRO, ownerUid: "uid-1", name: "Atelier Salma", slug: "atelier-salma-casablanca", description: "Céramique", citySlug: "casablanca", lifecycle: "verified", plan: "essentiel", ...overrides }) as unknown as ProProfileRecord;

  it("parses {slug}-{proId} and refuses what cannot carry a proId", () => {
    expect(parseStorefrontSegment(`atelier-salma-casablanca-${PRO}`)).toEqual({ slug: "atelier-salma-casablanca", proId: PRO });
    expect(parseStorefrontSegment(`-${PRO}`)).toBeNull();
    expect(parseStorefrontSegment(PRO)).toBeNull();
    expect(parseStorefrontSegment("atelier-SHEP2345")).toBeNull();
    expect(parseStorefrontSegment("atelier-shop1234")).toBeNull();
  });

  it("shows a verified shop with a plan, with the owner's published listings", async () => {
    repo.getProProfile.mockResolvedValue(shop());
    repo.getUserRecord.mockResolvedValue(user({ type: "pro" }));
    repo.listPublishedByOwner.mockResolvedValue([record("published")]);
    const store = await getPublicStorefront(PRO);
    expect(store).toMatchObject({ proId: PRO, segment: `atelier-salma-casablanca-${PRO}`, name: "Atelier Salma", citySlug: "casablanca" });
    expect(store?.seller.publishedCount).toBe(1);
    expect(store?.seller.listings.map((card) => card.id)).toEqual([ID]);
  });

  it("is a 404 when the storefront is not shown or the owner has no public face", async () => {
    for (const overrides of [{ lifecycle: "pending_verification" }, { lifecycle: "rejected" }, { lifecycle: "downgraded" }, { lifecycle: "suspended" }, { plan: "none" }] as const) {
      repo.getProProfile.mockResolvedValue(shop(overrides as Partial<ProProfileRecord>));
      repo.getUserRecord.mockResolvedValue(user({ type: "pro" }));
      expect(await getPublicStorefront(PRO), JSON.stringify(overrides)).toBeNull();
    }
    repo.getProProfile.mockResolvedValue(null);
    expect(await getPublicStorefront(PRO)).toBeNull();
    repo.getProProfile.mockResolvedValue(shop());
    for (const status of ["suspended", "banned", "closed"] as const) {
      repo.getUserRecord.mockResolvedValue(user({ type: "pro", status }));
      expect(await getPublicStorefront(PRO), status).toBeNull();
    }
    expect(repo.listPublishedByOwner).not.toHaveBeenCalled();
  });
});
