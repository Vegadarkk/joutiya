import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /api/saved-searches/** on the emulator with the memory engine (design D18): member session,
// Origin + CSRF on mutations, strict bodies, canonical stored parameters, a blank search refused,
// the same search twice -> 409 with the existing id, 10 per account, rename and alert switch,
// delete, no access to another account's searches, per-account limiters.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { GET as list, POST as create } from "@/app/api/saved-searches/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/saved-searches/[id]/route";
import { SAVED_SEARCHES_MAX, type SavedSearchCreate, type SavedSearchView } from "@/lib/contracts/search";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import { call, doc, expectError, member, serve, spend, type ErrorBody, type Member } from "../favorites/helpers";

type SearchBody = { search: SavedSearchView } & ErrorBody;

const NEWEST = Date.now() - 10 * 60_000;
const bike = doc({ title: "Velo electrique", categoryId: "vehicules", subcategoryId: "velos", citySlug: "casablanca", price: 3000, sortAt: NEWEST });
const older = doc({ title: "Velo de course", categoryId: "vehicules", subcategoryId: "velos", citySlug: "casablanca", price: 2500, sortAt: NEWEST - 86_400_000 });

const save = (who: Member, body: SavedSearchCreate | Record<string, unknown>, options: { csrf?: boolean } = {}) => call<SearchBody>(create, "POST", "/api/saved-searches", { member: who, body, ...options });
const searchesOf = async (who: Member) => (await call<{ searches: SavedSearchView[] } & ErrorBody>(list, "GET", "/api/saved-searches", { member: who })).body.searches;
const edit = (who: Member, id: string, body: Record<string, unknown>) => call<SearchBody>(patch, "PATCH", `/api/saved-searches/${id}`, { member: who, params: { id }, body });
const drop = (who: Member, id: string) => call<ErrorBody>(remove, "DELETE", `/api/saved-searches/${id}`, { member: who, params: { id } });
const stored = (who: Member, id: string) => db().collection(COLLECTIONS.users).doc(who.uid).collection(COLLECTIONS.savedSearches).doc(id).get();

beforeAll(async () => {
  resetServerEnv();
  await serve([bike, older]);
});
beforeEach(() => resetRateLimiters());
afterAll(() => setSearchEngineForTests(null));

describe("POST /api/saved-searches", () => {
  it("stores the canonical search, alert on, cursor at the newest matching listing", async () => {
    const salma = await member();
    const result = await save(salma, { name: "Vélos à Casa", params: { category: "vehicules", subcategory: "velos", city: "casablanca", sort: "recent" } });
    expect(result.status).toBe(201);
    expect(result.body.search).toMatchObject({ name: "Vélos à Casa", alert: "daily", params: { subcategory: "velos", city: "casablanca" } });
    expect(result.body.search.id).toMatch(/^[A-Za-z0-9]{20}$/);
    const snapshot = await stored(salma, result.body.search.id);
    expect(snapshot.get("lastNotifiedSortAt")).toBe(NEWEST);
    expect(snapshot.get("params")).not.toHaveProperty("page");
    expect(await searchesOf(salma)).toEqual([result.body.search]);
  });

  it("names a search after its words, refuses a blank one and unknown fields", async () => {
    const salma = await member();
    const words = await save(salma, { params: { q: "velo electrique" }, alert: "none" });
    expect(words.status).toBe(201);
    expect(words.body.search).toMatchObject({ name: "velo electrique", alert: "none" });
    expect((await stored(salma, words.body.search.id)).get("lastNotifiedSortAt")).toBe(NEWEST);
    expectError(await save(salma, { params: { sort: "price_asc" } }), 400, "invalid_body");
    expectError(await save(salma, { params: { q: "velo", page: 2 } }), 400, "invalid_body");
    expectError(await save(salma, { params: { q: "velo" }, owner: "x" }), 400, "invalid_body");
    expectError(await save(salma, { name: "x".repeat(61), params: { q: "velo" } }), 400, "invalid_body");
  });

  it("answers 409 with the existing id for the same search, whatever the sort or name", async () => {
    const salma = await member();
    const first = await save(salma, { params: { subcategory: "velos", category: "vehicules" } });
    const twice = await save(salma, { name: "Autre nom", params: { category: "vehicules", subcategory: "velos" } });
    expectError(twice, 409, "saved_search_exists");
    expect(twice.body.error.details).toEqual({ id: first.body.search.id });
    expect(await searchesOf(salma)).toHaveLength(1);
  });

  it(`keeps ${SAVED_SEARCHES_MAX} searches per account`, async () => {
    const salma = await member();
    for (let index = 0; index < SAVED_SEARCHES_MAX; index += 1) expect((await save(salma, { params: { q: `objet ${index}` } })).status).toBe(201);
    expectError(await save(salma, { params: { q: "un de trop" } }), 409, "saved_search_limit");
    const all = await searchesOf(salma);
    expect(all).toHaveLength(SAVED_SEARCHES_MAX);
    expect(new Set(all.map((search) => search.name))).toEqual(new Set(Array.from({ length: SAVED_SEARCHES_MAX }, (_, index) => `objet ${index}`)));
    expect((await drop(salma, all[0]!.id)).status).toBe(204);
    expect((await save(salma, { params: { q: "un de trop" } })).status).toBe(201);
  });

  it("needs a session and the CSRF token, and limits writes per account", async () => {
    const salma = await member();
    expectError(await call(create, "POST", "/api/saved-searches", { body: { params: { q: "velo" } } }), 401, "unauthenticated");
    expectError(await save(salma, { params: { q: "velo" } }, { csrf: false }), 403, "csrf");
    await spend("savedSearch.write.uid", salma.uid);
    expectError(await save(salma, { params: { q: "velo" } }), 429, "rate_limited");
    expect(await searchesOf(salma)).toEqual([]);
    await spend("savedSearch.read.uid", salma.uid);
    expectError(await call(list, "GET", "/api/saved-searches", { member: salma }), 429, "rate_limited");
  });

  it("charges the list in documents read on a daily budget (savedSearch.docs.uid)", async () => {
    const salma = await member();
    expect((await save(salma, { params: { q: "velo" } })).status).toBe(201);
    expect((await save(salma, { params: { q: "canape" } })).status).toBe(201);
    expect(await searchesOf(salma)).toHaveLength(2);
    expect((await limitState("savedSearch.docs.uid", salma.uid))?.consumedPoints).toBe(2);
    await spend("savedSearch.docs.uid", salma.uid);
    expectError(await call(list, "GET", "/api/saved-searches", { member: salma }), 429, "rate_limited");
  });
});

describe("PATCH and DELETE /api/saved-searches/{id}", () => {
  it("renames, switches the alert off and on (cursor never goes back), deletes", async () => {
    const salma = await member();
    const { id } = (await save(salma, { params: { q: "velo" } })).body.search;
    const renamed = await edit(salma, id, { name: "  Mon vélo  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.search).toMatchObject({ id, name: "Mon vélo", alert: "daily" });
    expect((await edit(salma, id, { alert: "none" })).body.search.alert).toBe("none");
    const before = Date.now();
    expect((await edit(salma, id, { alert: "daily" })).body.search.alert).toBe("daily");
    expect((await stored(salma, id)).get("lastNotifiedSortAt")).toBeGreaterThanOrEqual(before);
    expectError(await edit(salma, id, {}), 400, "invalid_body");
    expectError(await edit(salma, id, { alert: "weekly" }), 400, "invalid_body");
    expect((await drop(salma, id)).status).toBe(204);
    expectError(await drop(salma, id), 404, "not_found");
    expectError(await edit(salma, id, { name: "x" }), 404, "not_found");
  });

  it("never reaches another account's search", async () => {
    const salma = await member();
    const karim = await member();
    const { id } = (await save(salma, { params: { q: "canape" } })).body.search;
    expectError(await edit(karim, id, { name: "pris" }), 404, "not_found");
    expectError(await drop(karim, id), 404, "not_found");
    expectError(await edit(salma, "not-an-id", { name: "x" }), 404, "not_found");
    expect((await searchesOf(salma))[0]).toMatchObject({ id, name: "canape" });
  });
});
