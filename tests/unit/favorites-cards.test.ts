import { describe, expect, it } from "vitest";
import { decodeFavoritesCursor, encodeFavoritesCursor, favoriteView, snapshotCard, snapshotOf } from "@/lib/favorites/cards";
import { favoriteSnapshotSchema } from "@/lib/db/schemas";
import type { SearchCard } from "@/lib/search/types";

// D17: the snapshot a favorite keeps, the card it shows, and the opaque page cursor.

const CARD: SearchCard = {
  id: "abcd2345",
  slugId: "velo-de-ville-casablanca-abcd2345",
  title: "Vélo de ville",
  subcategoryId: "velos",
  price: 1500,
  priceNegotiable: true,
  isDonation: false,
  citySlug: "casablanca",
  photo: { id: "ph1", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
  photoCount: 3,
  sellerType: "pro",
  sortAt: "2026-10-15T08:00:00.000Z",
  bumped: true,
  featured: true,
};

describe("favorite cards", () => {
  it("snapshots the card fields the schema stores, nothing else", () => {
    const snapshot = snapshotOf(CARD);
    expect(favoriteSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(Object.keys(snapshot)).not.toContain("featured");
    expect(Object.keys(snapshot)).not.toContain("sortAt");
  });

  it("rebuilds a neutral card from a snapshot, dated by the favorite", () => {
    const created = new Date("2026-10-16T09:00:00Z");
    expect(snapshotCard(CARD.id, snapshotOf(CARD), created)).toEqual({ ...CARD, sortAt: created.toISOString(), bumped: false, featured: false });
  });

  it("serves the live card while indexed, the snapshot marked unavailable otherwise", () => {
    const created = new Date("2026-10-16T09:00:00Z");
    expect(favoriteView(CARD.id, created, snapshotOf(CARD), CARD)).toEqual({ listingId: CARD.id, createdAt: created.toISOString(), card: CARD, available: true });
    const gone = favoriteView(CARD.id, created, snapshotOf(CARD), undefined);
    expect(gone.available).toBe(false);
    expect(gone.card.title).toBe(CARD.title);
  });

  it("round-trips the cursor and refuses anything else", () => {
    const cursor = { at: new Date("2026-10-16T09:00:00.123Z"), id: "abcd2345" };
    expect(decodeFavoritesCursor(encodeFavoritesCursor(cursor))).toEqual(cursor);
    expect(decodeFavoritesCursor("not a cursor")).toBeNull();
    expect(decodeFavoritesCursor(Buffer.from("123.ABCD1234").toString("base64url"))).toBeNull();
    expect(decodeFavoritesCursor(Buffer.from("x.abcd2345").toString("base64url"))).toBeNull();
    expect(decodeFavoritesCursor(Buffer.from("1.abcd2345.z").toString("base64url"))).toBeNull();
  });
});
