import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as priceGuideRoute } from "@/app/api/listings/[id]/price-guide/route";
import { priceGuidePath, type PriceGuideResponse } from "@/lib/contracts/price-guide";
import { priceGuideCacheKey, setPriceGuideCacheForTests, type GuideCache } from "@/lib/price-guide/service";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import { call, expectError, spend, type ErrorBody } from "../favorites/helpers";
import { member, seedListing } from "../messaging/helpers";
import { doc, serve } from "../search/search-helpers";

// GET /api/listings/{id}/price-guide on the emulators (Carte vivante lot 5): the guide of a
// published listing from the comparables in the index, the 24 h cache, 404 for what is not public,
// and the per-IP limit.

const entries = new Map<string, string>();
const cache: GuideCache = {
  get: async (key) => entries.get(key) ?? null,
  set: async (key, value) => {
    entries.set(key, value);
  },
};

beforeEach(() => {
  resetRateLimiters();
  entries.clear();
  setPriceGuideCacheForTests(cache);
});

afterAll(() => {
  setPriceGuideCacheForTests(undefined);
  setSearchEngineForTests(null);
});

const get = (id: string, ip = "10.98.7.1") => call<PriceGuideResponse & ErrorBody>(priceGuideRoute, "GET", priceGuidePath(id), { params: { id }, ip, origin: null });

const bike = (citySlug: string, price: number, bikeType = "enfant") =>
  doc({ title: `Vélo enfant ${price}`, categoryId: "vehicules", subcategoryId: "velos", citySlug, price, a_bike_type: bikeType });

describe("price guide API", () => {
  it("answers the typical range of the comparables in the city, cacheable, then from the cache", async () => {
    const seller = await member({ displayName: "Salma Vendeuse" });
    const listing = await seedListing(seller, { price: 450, attributes: { "bike-type": "enfant" } });
    await serve([...[250, 300, 350, 380, 400, 450, 480, 500, 550, 700].map((price) => bike("casablanca", price)), bike("casablanca", 9000, "vtt")]);

    const first = await get(listing.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.header("cache-control")).toBe("public, max-age=3600, s-maxage=3600");
    expect(first.body.price).toBe(450);
    expect(first.body.guide).toMatchObject({ scope: "city", place: "casablanca", count: 10 });
    expect(first.body.guide!.p25).toBeLessThanOrEqual(first.body.guide!.p75);
    expect(first.body.guide!.high).toBeLessThan(9000);
    expect(entries.has(priceGuideCacheKey(listing.id))).toBe(true);

    // Same answer from the cache, the engine no longer asked.
    setSearchEngineForTests({ kind: "memory", search: async () => Promise.reject(new Error("not asked")) } as never);
    expect((await get(listing.id)).body).toEqual(first.body);
  });

  it("answers no guide below 8 comparables, and 404 for what is not public", async () => {
    const seller = await member({ displayName: "Salma Vendeuse" });
    const listing = await seedListing(seller, { price: 450, attributes: { "bike-type": "enfant" } });
    await serve([300, 350, 400].map((price) => bike("casablanca", price)));
    const thin = await get(listing.id);
    expect(thin.status).toBe(200);
    expect(thin.body).toEqual({ guide: null, price: 450 });

    const draft = await seedListing(seller, { status: "draft" });
    expectError(await get(draft.id), 404, "not_found");
    expectError(await get("zzzz2345"), 404, "not_found");
    expectError(await get("not-an-id!"), 404, "not_found");
  });

  it("limits each IP", async () => {
    const seller = await member({ displayName: "Salma Vendeuse" });
    const listing = await seedListing(seller, { price: 450 });
    await serve([]);
    await spend("priceguide.ip", "10.98.7.9");
    expectError(await get(listing.id, "10.98.7.9"), 429, "rate_limited");
  });
});
