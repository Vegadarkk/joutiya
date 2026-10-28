import { describe, expect, it, vi } from "vitest";
import { sortShelf } from "@/components/profile/listing-shelf";
import { storefrontSchema } from "@/lib/contracts/account";
import { firstStrictIssue, screenFreeText } from "@/lib/moderation/free-text";

// Storefront of a member (vitrine-avis §1): the free-text screen shared by the bio and the reviews,
// the settings body, the patch the API stores and the in-browser sort of the listings.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/repositories/profiles", () => ({ getUserRecord: vi.fn() }));
vi.mock("@/lib/db/repositories/users", () => ({ updateStorefront: vi.fn() }));
vi.mock("@/lib/listings/revalidate", () => ({ revalidateListingPaths: vi.fn() }));
const { storefrontPatch, storefrontSettings } = await import("@/lib/account/storefront");

describe("free-text screen", () => {
  it("passes plain text", () => {
    expect(screenFreeText("Vélos révisés, rencontre à Casablanca le week-end.")).toEqual({ blockers: [], sensitive: false });
    expect(firstStrictIssue("Bonjour, je vends mes livres d'école.")).toBeNull();
  });

  it("refuses contact details: messaging is the only channel", () => {
    expect(screenFreeText("Appelez le 06 12 34 56 78").blockers).toContain("phone_in_text");
    expect(screenFreeText("Écrivez à salma@example.com").blockers).toContain("email_in_text");
    expect(screenFreeText("Voir https://example.com/shop").blockers).toContain("url_in_text");
  });
});

describe("storefront settings", () => {
  it("accepts a partial body and refuses unknown banners and fields", () => {
    expect(storefrontSchema.parse({ bannerKey: "nuit" })).toEqual({ bannerKey: "nuit" });
    expect(storefrontSchema.parse({ bio: null, citySlug: null })).toEqual({ bio: null, citySlug: null });
    expect(storefrontSchema.safeParse({ bannerKey: "photo" }).success).toBe(false);
    expect(storefrontSchema.safeParse({ bio: "x".repeat(501) }).success).toBe(false);
    expect(storefrontSchema.safeParse({ avatarKey: "a" }).success).toBe(false);
  });

  it("builds the patch: an empty bio clears it, the city carries its region", () => {
    expect(storefrontPatch({ bio: "  " })).toEqual({ bio: null });
    expect(storefrontPatch({ bio: " Bonjour ", bannerKey: "dunes" })).toEqual({ bio: "Bonjour", bannerKey: "dunes" });
    expect(storefrontPatch({ citySlug: "casablanca" })).toEqual({ city: { citySlug: "casablanca", regionCode: expect.stringMatching(/^\d{2}$/) } });
    expect(storefrontPatch({ citySlug: null })).toEqual({ city: null });
  });

  it("refuses a bio the screen blocks, naming the field and the issue", () => {
    expect(() => storefrontPatch({ bio: "Mon numéro : 0612345678" })).toThrow(expect.objectContaining({ status: 422, code: "invalid_text", details: { field: "bio", issue: "phone_in_text" } }));
    expect(() => storefrontPatch({ citySlug: "atlantide" })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("answers the default banner until one is chosen", () => {
    const base = { publicId: "abcdefghjk", citySlug: undefined } as unknown as Parameters<typeof storefrontSettings>[0];
    expect(storefrontSettings(base)).toEqual({ publicId: "abcdefghjk", bio: "", bannerKey: "zellige", citySlug: null });
  });
});

describe("listing shelf sort", () => {
  const items = [
    { id: "a", price: 300, sortAt: "2026-10-01T00:00:00.000Z" },
    { id: "b", price: null, sortAt: "2026-10-03T00:00:00.000Z" },
    { id: "c", price: 100, sortAt: "2026-10-02T00:00:00.000Z" },
  ];
  const order = (sort: Parameters<typeof sortShelf>[1]) => sortShelf(items, sort).map((item) => item.id);

  it("sorts newest first, or by price with unpriced listings last", () => {
    expect(order("recent")).toEqual(["b", "c", "a"]);
    expect(order("priceAsc")).toEqual(["c", "a", "b"]);
    expect(order("priceDesc")).toEqual(["a", "c", "b"]);
  });
});
