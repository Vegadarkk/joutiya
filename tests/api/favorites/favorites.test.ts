import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /api/favorites/** on the emulator with the memory engine (design D17): member session, Origin +
// CSRF on PUT/DELETE, a favorite needs an indexed listing and keeps its snapshot, PUT is idempotent
// (201 then 200), DELETE always 204, the 300 cap, live cards vs "no longer available" snapshots,
// cursor pages of 48, the per-account limiters. Valkey is not configured: the hearts come from
// the subcollection.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { GET as list } from "@/app/api/favorites/route";
import { GET as ids } from "@/app/api/favorites/ids/route";
import { DELETE as remove, PUT as put } from "@/app/api/favorites/[listingId]/route";
import { FAVORITES_MAX, FAVORITES_PAGE_SIZE, type FavoriteView, type FavoritesPage } from "@/lib/contracts/search";
import { COLLECTIONS, type FavoriteSnapshot } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import type { MemoryEngine } from "@/lib/search/memory";
import { call, doc, expectError, member, serve, spend, type ErrorBody, type Member } from "./helpers";

type FavoriteBody = { favorite: FavoriteView } & ErrorBody;

let engine: MemoryEngine;
const bike = doc({ title: "Velo de ville", categoryId: "vehicules", subcategoryId: "velos", citySlug: "casablanca", price: 1500 });
const sofa = doc({ title: "Canape trois places", categoryId: "maison", subcategoryId: "ameublement", citySlug: "rabat", price: 2000 });
const lamp = doc({ title: "Lampe de bureau", categoryId: "maison", subcategoryId: "ameublement", citySlug: "rabat", isDonation: true });

const SNAPSHOT: FavoriteSnapshot = { slugId: "ancien-velo-abcd2345", title: "Ancien vélo", subcategoryId: "velos", price: 300, priceNegotiable: false, isDonation: false, citySlug: "fes", photo: null, photoCount: 0, sellerType: "individual" };

const add = (who: Member, listingId: string, options: { csrf?: boolean; origin?: string | null } = {}) => call<FavoriteBody>(put, "PUT", `/api/favorites/${listingId}`, { member: who, params: { listingId }, ...options });
const drop = (who: Member, listingId: string) => call<ErrorBody>(remove, "DELETE", `/api/favorites/${listingId}`, { member: who, params: { listingId } });
const heartIds = async (who: Member) => (await call<{ ids: string[] }>(ids, "GET", "/api/favorites/ids", { member: who })).body.ids;
const page = (who: Member, cursor?: string) => call<FavoritesPage & ErrorBody>(list, "GET", cursor === undefined ? "/api/favorites" : `/api/favorites?cursor=${encodeURIComponent(cursor)}`, { member: who });

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** A valid listing id, distinct per index and from the indexed documents ("t..."). */
function fixtureId(index: number): string {
  let id = "";
  for (let n = index, i = 0; i < 7; i += 1, n = Math.floor(n / ALPHABET.length)) id = `${ALPHABET[n % ALPHABET.length]}${id}`;
  return `s${id}`;
}

/** Favorites written straight to the subcollection (fixtures beyond what a test should PUT). */
async function seedFavorites(uid: string, count: number, start = Date.now() - 86_400_000): Promise<string[]> {
  const listingIds: string[] = [];
  const writer = db().bulkWriter();
  for (let index = 0; index < count; index += 1) {
    const id = fixtureId(index);
    listingIds.push(id);
    void writer.set(db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.favorites).doc(id), datesToTimestamps({ createdAt: new Date(start + index), listingSnapshot: { ...SNAPSHOT, slugId: `ancien-velo-${id}` } }));
  }
  await writer.close();
  return listingIds;
}

beforeAll(async () => {
  resetServerEnv();
  engine = await serve([bike, sofa, lamp]);
});
beforeEach(() => resetRateLimiters());
afterAll(() => setSearchEngineForTests(null));

describe("PUT and DELETE /api/favorites/{listingId}", () => {
  it("adds an indexed listing (201, then 200), shows it in the hearts, removes it (204, twice)", async () => {
    const salma = await member();
    const first = await add(salma, bike.id);
    expect(first.status).toBe(201);
    expect(first.body.favorite).toMatchObject({ listingId: bike.id, available: true, card: { id: bike.id, title: "Velo de ville", price: 1500, citySlug: "casablanca" } });
    const stored = await db().collection(COLLECTIONS.users).doc(salma.uid).collection(COLLECTIONS.favorites).doc(bike.id).get();
    expect(stored.get("listingSnapshot")).toMatchObject({ slugId: bike.slugId, title: "Velo de ville", price: 1500 });

    const again = await add(salma, bike.id);
    expect(again.status).toBe(200);
    expect(again.body.favorite.createdAt).toBe(first.body.favorite.createdAt);
    expect(await heartIds(salma)).toEqual([bike.id]);

    expect((await drop(salma, bike.id)).status).toBe(204);
    expect((await drop(salma, bike.id)).status).toBe(204);
    expect(await heartIds(salma)).toEqual([]);
  });

  it("refuses a listing out of the index, a malformed id, and another account sees nothing", async () => {
    const salma = await member();
    const karim = await member();
    expectError(await add(salma, "zzzz2345"), 409, "listing_unavailable");
    expectError(await add(salma, "NOT-AN-ID"), 404, "not_found");
    expect((await add(salma, sofa.id)).status).toBe(201);
    expect(await heartIds(karim)).toEqual([]);
    expect((await page(karim)).body.favorites).toEqual([]);
  });

  it("needs a session, the Origin and the CSRF token", async () => {
    const salma = await member();
    expectError(await call(put, "PUT", `/api/favorites/${bike.id}`, { params: { listingId: bike.id } }), 401, "unauthenticated");
    expectError(await call(ids, "GET", "/api/favorites/ids"), 401, "unauthenticated");
    expectError(await add(salma, bike.id, { csrf: false }), 403, "csrf");
    expectError(await add(salma, bike.id, { origin: "https://evil.example" }), 403, "origin");
    expect(await heartIds(salma)).toEqual([]);
  });

  it(`stops at ${FAVORITES_MAX} favorites, and frees a place on removal`, async () => {
    const salma = await member();
    const seeded = await seedFavorites(salma.uid, FAVORITES_MAX);
    expect((await heartIds(salma)).length).toBe(FAVORITES_MAX);
    expectError(await add(salma, bike.id), 409, "favorite_limit");
    // Already a favorite: still answered, the cap only blocks new ones.
    expect((await drop(salma, seeded[0]!)).status).toBe(204);
    expect((await add(salma, bike.id)).status).toBe(201);
    expectError(await add(salma, sofa.id), 409, "favorite_limit");
    expect((await add(salma, bike.id)).status).toBe(200);
  });

  it("limits writes per account (favorites.write.uid) before any read", async () => {
    const salma = await member();
    const karim = await member();
    await spend("favorites.write.uid", salma.uid);
    const limited = await add(salma, bike.id);
    expectError(limited, 429, "rate_limited");
    expect(Number(limited.header("retry-after"))).toBeGreaterThan(0);
    expectError(await drop(salma, bike.id), 429, "rate_limited");
    expect((await add(karim, bike.id)).status).toBe(201);
    await spend("favorites.read.uid", karim.uid);
    expectError(await call(ids, "GET", "/api/favorites/ids", { member: karim }), 429, "rate_limited");
  });
});

describe("GET /api/favorites", () => {
  it("serves live cards newest first, and the snapshot of a listing gone as unavailable", async () => {
    const salma = await member();
    expect((await add(salma, bike.id)).status).toBe(201);
    expect((await add(salma, lamp.id)).status).toBe(201);
    await engine.upsert([{ ...bike, title: "Velo de ville revise", version: 2 }]);
    await engine.remove([lamp.id]);
    try {
      const result = await page(salma);
      expect(result.status).toBe(200);
      expect(result.body.total).toBe(2);
      expect(result.body.next).toBeUndefined();
      expect(result.body.favorites.map((favorite) => [favorite.listingId, favorite.available, favorite.card.title])).toEqual([
        [lamp.id, false, "Lampe de bureau"],
        [bike.id, true, "Velo de ville revise"],
      ]);
      expect(result.body.favorites[0]?.card).toMatchObject({ isDonation: true, slugId: lamp.slugId });
      // A favorite whose listing left the index can still be removed.
      expect((await drop(salma, lamp.id)).status).toBe(204);
    } finally {
      await engine.upsert([bike, lamp]);
    }
  });

  it(`pages by ${FAVORITES_PAGE_SIZE} with an opaque cursor, and refuses a forged one`, async () => {
    const salma = await member();
    const seeded = await seedFavorites(salma.uid, FAVORITES_PAGE_SIZE + 5);
    const first = await page(salma);
    expect(first.body.favorites).toHaveLength(FAVORITES_PAGE_SIZE);
    expect(first.body.total).toBe(FAVORITES_PAGE_SIZE + 5);
    expect(first.body.favorites[0]?.listingId).toBe(seeded[seeded.length - 1]);
    expect(first.body.favorites.every((favorite) => !favorite.available)).toBe(true);
    const second = await page(salma, first.body.next);
    expect(second.body.favorites.map((favorite) => favorite.listingId)).toEqual(seeded.slice(0, 5).reverse());
    expect(second.body.next).toBeUndefined();
    expectError(await page(salma, "forged"), 400, "invalid_body");
  });
});
