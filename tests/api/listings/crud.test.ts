import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Drafts of the listings API against the emulators (design §3): create (5 per account), owner-only
// GET / PATCH / DELETE (404 for anyone else, 401 anonymous, 403 without CSRF), the wizard patch and
// its server-side checks (city, region, photos filtered to the owner's ready uploads), saves that
// change nothing (no write), dropped photos handed to the purge, removal.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as create } from "@/app/api/listings/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { DELETE as remove, GET as get, PATCH as patch } from "@/app/api/listings/[id]/route";
import { MAX_DRAFTS, type CreateListingResponse, type OwnerListingsResponse } from "@/lib/contracts/listings";
import { listContentOps, listingContentRef } from "@/lib/db/repositories/content-ops";
import { getListing, listingRef, updateListing } from "@/lib/db/repositories/listings";
import { getUpload, newUploadId } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { LISTING_ID_PATTERN } from "@/lib/listings/ids";
import { logger } from "@/lib/logging/logger";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { api, attachPhoto, DAY_MS, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

async function draft(owner: Member, body: unknown = {}): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body });
  expect(created.status).toBe(201);
  return created.body.id;
}

describe("POST /api/listings", () => {
  it("creates an empty draft the owner can read and list", async () => {
    const owner = await member();
    const id = await draft(owner, { subcategoryId: "velos" });
    expect(id).toMatch(LISTING_ID_PATTERN);

    const read = await api<ListingBody>(get, "GET", `/api/listings/${id}`, { member: owner });
    expect(read.status).toBe(200);
    expect(read.header("cache-control")).toBe("no-store");
    expect(read.body.listing).toMatchObject({ id, status: "draft", categoryId: "vehicules", subcategoryId: "velos", title: "", description: "", photos: [], price: null, version: 0, slugId: null, publishedAt: null });

    const drafts = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine", { member: owner });
    expect(drafts.status).toBe(200);
    expect(drafts.body.listings.map((listing) => listing.id)).toEqual([id]);
    expect((await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=active", { member: owner })).body.listings).toEqual([]);
    // The creation is recorded with the clear IP (LCEN).
    expect(await listContentOps(listingContentRef(id))).toEqual([expect.objectContaining({ uid: owner.uid, op: "listing.create", ip: owner.jar.ip })]);
  });

  it("puts the draft on a 30-day clock that each save restarts (A4-04)", async () => {
    const owner = await member();
    const before = Date.now();
    const id = await draft(owner);
    const created = (await getListing(id))!.purgeAt!.getTime();
    expect(created).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(created).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    // An old clock (as if left untouched for 20 days) is pushed back by the next save.
    await updateListing(id, { purgeAt: new Date(before + 10 * DAY_MS) });
    const beforeSave = Date.now();
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo de ville" } })).status).toBe(200);
    expect((await getListing(id))!.purgeAt!.getTime()).toBeGreaterThanOrEqual(beforeSave + 30 * DAY_MS);
  });

  it("refuses a sixth draft (draft_limit) and an unknown or inconsistent tree", async () => {
    const owner = await member();
    for (let i = 0; i < MAX_DRAFTS; i += 1) await draft(owner);
    const sixth = await api<ErrorBody>(create, "POST", "/api/listings", { member: owner, body: {} });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe("draft_limit");

    const unknown = await api<ErrorBody>(create, "POST", "/api/listings", { member: await member(), body: { subcategoryId: "licornes" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_body");
    const mismatch = await api<ErrorBody>(create, "POST", "/api/listings", { member: await member(), body: { categoryId: "mode", subcategoryId: "velos" } });
    expect(mismatch.status).toBe(400);
  });

  it("needs a session, the Origin header and the CSRF token", async () => {
    const owner = await member();
    expect((await api<ErrorBody>(create, "POST", "/api/listings", { body: {} })).status).toBe(401);
    const noCsrf = await api<ErrorBody>(create, "POST", "/api/listings", { member: owner, body: {}, csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("csrf");
    const noOrigin = await api<ErrorBody>(create, "POST", "/api/listings", { member: owner, body: {}, origin: null });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("origin");
  });
});

describe("GET /api/listings/mine", () => {
  it("rejects an unknown tab", async () => {
    const owner = await member();
    const bad = await api<ErrorBody>(mine, "GET", "/api/listings/mine?status=all", { member: owner });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_body");
    expect((await api(mine, "GET", "/api/listings/mine")).status).toBe(401);
  });
});

describe("PATCH /api/listings/{id}", () => {
  it("saves every wizard step and answers the owner view", async () => {
    const owner = await member();
    const id = await draft(owner);
    const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ location: { regionCode: "06", citySlug: "casablanca", district: "Maarif" } }) });
    expect(saved.status).toBe(200);
    expect(saved.body.listing).toMatchObject({
      status: "draft",
      categoryId: "vehicules",
      subcategoryId: "velos",
      title: "Vélo de ville Peugeot en bon état",
      attributes: { "bike-type": "ville", brand: "Peugeot" },
      condition: "good",
      price: 1500,
      priceNegotiable: true,
      location: { regionCode: "06", citySlug: "casablanca", district: "Maarif" },
      contact: { showPhone: false, whatsapp: false },
      version: 1,
    });
    // The document carries the city centroid, never an address; the owner view hides it.
    const stored = await getListing(id);
    expect(stored?.location?.geo).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
    expect(Object.keys(saved.body.listing.location ?? {})).not.toContain("geo");
    // Switching subcategory drops the criteria of the previous one.
    const switched = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { subcategoryId: "voitures" } });
    expect(switched.body.listing).toMatchObject({ subcategoryId: "voitures", attributes: {}, version: 2 });
  });

  it("checks the body: strict schema, text bounds, unknown city, region mismatch", async () => {
    const owner = await member();
    const id = await draft(owner);
    const codes: [number, string][] = [];
    // A short title is a valid draft (D2 autosave keeps half-typed text); an overlong one is refused.
    for (const body of [{ ownerUid: "x" }, { title: "V".repeat(71) }, { price: -1 }, { location: { regionCode: "06", citySlug: "atlantis" } }, { location: { regionCode: "04", citySlug: "casablanca" } }]) {
      const result = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body });
      codes.push([result.status, result.body.error.code]);
    }
    expect(codes).toEqual([[400, "invalid_body"], [400, "invalid_body"], [400, "invalid_body"], [400, "invalid_body"], [400, "invalid_body"]]);
    const city = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { location: { regionCode: "06", citySlug: "atlantis" } } });
    expect(city.body.error.details).toEqual([{ path: "location.citySlug", code: "unknown" }]);
    expect((await getListing(id))?.version).toBe(0);
    const short = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo" } });
    expect(short.status).toBe(200);
  });

  it("keeps only the owner's ready uploads of this listing as photos, in the order sent", async () => {
    const owner = await member();
    const other = await member();
    const id = await draft(owner);
    const otherId = await draft(other);
    const first = await seedReadyUpload(owner, id);
    const second = await seedReadyUpload(owner, id);
    const processing = await seedReadyUpload(owner, id, { status: "processing" });
    const foreign = await seedReadyUpload(other, otherId);
    const elsewhere = await seedReadyUpload(owner, otherId);

    const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [second, processing, foreign, elsewhere, first, first] } });
    expect(saved.status).toBe(200);
    // Ready photos first (sent order), then the one still processing for the wizard.
    expect(saved.body.listing.photos).toEqual([
      { id: second, status: "ready", w: 1600, h: 1200, blurhash: expect.any(String) },
      { id: first, status: "ready", w: 1600, h: 1200, blurhash: expect.any(String) },
      { id: processing, status: "processing" },
    ]);
    const stored = await getListing(id);
    expect(stored?.photos.map((photo) => photo.id)).toEqual([second, first]);
    // Dropping a photo detaches it.
    const trimmed = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [first] } });
    expect(trimmed.body.listing.photos.filter((photo) => photo.status === "ready").map((photo) => photo.id)).toEqual([first]);
  });

  it("hands the photos a save drops to the purge (purgeAt now); a lost upload document does not fail the save", async () => {
    const owner = await member();
    const id = await draft(owner);
    const kept = await seedReadyUpload(owner, id);
    const dropped = await seedReadyUpload(owner, id);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [kept, dropped] } })).status).toBe(200);
    const keptPurge = (await getUpload(kept))!.purgeAt;
    const before = Date.now();
    const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [kept] } });
    expect(saved.status).toBe(200);
    // Due now: the hourly purge-quarantine deletes it once it checks no listing holds it again.
    const purgeAt = (await getUpload(dropped))!.purgeAt.getTime();
    expect(purgeAt).toBeGreaterThanOrEqual(before);
    expect(purgeAt).toBeLessThanOrEqual(Date.now());
    expect((await getUpload(kept))?.purgeAt).toEqual(keptPurge);

    // A photo on the listing without its upload document: the save still goes through, logged.
    const lost = newUploadId();
    await attachPhoto(id, lost);
    const warn = vi.spyOn(logger, "warn");
    const trimmed = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [kept] } });
    expect(trimmed.status).toBe(200);
    expect((await getListing(id))?.photos.map((photo) => photo.id)).toEqual([kept]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ listingId: id, uploadId: lost }), "dropped photo not handed to the purge");
  });

  it("stores a null price (to discuss, a donation) as null: the listing stays readable", async () => {
    const owner = await member();
    const id = await draft(owner);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 1500 } })).body.listing.price).toBe(1500);
    const cleared = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.listing.price).toBeNull();
    expect((await listingRef(id).get()).get("price")).toBeNull();
    expect((await api<ListingBody>(get, "GET", `/api/listings/${id}`, { member: owner })).body.listing.price).toBeNull();
    // A donation clears the price the same way.
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 900 } })).body.listing.price).toBe(900);
    const donation = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { isDonation: true } });
    expect(donation.body.listing).toMatchObject({ isDonation: true, price: null });
    expect(await getListing(id)).toMatchObject({ isDonation: true, price: null });
  });

  it("writes nothing when a save changes nothing: resent values, an empty body, the same declaration", async () => {
    const owner = await member();
    const id = await draft(owner);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ sensitiveDeclaration: { kind: "self" } }) })).body.listing.version).toBe(1);
    const stored = (await getListing(id))!;
    for (const body of [readyPatch(), {}, { title: stored.title, price: 1500, condition: "good" }, { sensitiveDeclaration: { kind: "self" } }, { subcategoryId: "velos" }]) {
      const same = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body });
      expect(same.status, JSON.stringify(body)).toBe(200);
      expect(same.body.listing).toMatchObject({ version: 1, title: stored.title, sensitiveDeclaration: { kind: "self" } });
    }
    expect(await getListing(id)).toEqual(stored);
    // One changed field among resent ones is saved.
    const changed = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ price: 1400 }) });
    expect(changed.body.listing).toMatchObject({ version: 2, price: 1400 });
    // Another declaration is a new one, dated now.
    const other = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { sensitiveDeclaration: { kind: "explicit_consent" } } });
    expect(other.body.listing.version).toBe(3);
    expect((await getListing(id))?.moderation.sensitiveDeclaration).toEqual({ kind: "explicit_consent", at: expect.any(Date) });
  });

  it("refuses more photos than the quota (photo_limit)", async () => {
    const owner = await member();
    const id = await draft(owner);
    const ids = await Promise.all(Array.from({ length: 11 }, () => seedReadyUpload(owner, id)));
    const tooMany = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: ids } });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("photo_limit");
  });
});

describe("ownership and removal", () => {
  it("answers 404 to another member and to a malformed id, 401 anonymous", async () => {
    const owner = await member();
    const stranger = await member();
    const id = await draft(owner);
    for (const [handler, method, body] of [[get, "GET", undefined], [patch, "PATCH", { title: "Vélo volé" }], [remove, "DELETE", undefined]] as const) {
      const result = await api<ErrorBody>(handler, method, `/api/listings/${id}`, { member: stranger, body });
      expect(result.status, method).toBe(404);
      expect(result.body.error.code).toBe("not_found");
    }
    expect((await api(get, "GET", "/api/listings/not-an-id!", { member: owner })).status).toBe(404);
    expect((await api(get, "GET", `/api/listings/${id}`)).status).toBe(401);
    expect((await getListing(id))?.title).toBe("");
  });

  it("DELETE removes the listing (204); its photos stay until the listing's own purge", async () => {
    const owner = await member();
    const id = await draft(owner);
    const upload = await seedReadyUpload(owner, id);
    await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } });
    const uploadPurge = (await getUpload(upload))!.purgeAt;
    const before = Date.now();
    const removed = await api(remove, "DELETE", `/api/listings/${id}`, { member: owner });
    expect(removed.status).toBe(204);

    const stored = await getListing(id);
    expect(stored).toMatchObject({ status: "removed", version: 2 });
    expect(stored?.purgeAt?.getTime()).toBeGreaterThan(before);
    // retention-purge deletes text and photos together at the listing's purgeAt (§5, §7).
    expect((await getUpload(upload))?.purgeAt).toEqual(uploadPurge);
    // Gone from every tab (a deleted listing is not "ended"); no further edit.
    expect((await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine", { member: owner })).body.listings).toEqual([]);
    expect((await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=ended", { member: owner })).body.listings).toEqual([]);
    const edit = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Encore là ?" } });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("conflict");
    expect(await listContentOps(listingContentRef(id))).toEqual(expect.arrayContaining([expect.objectContaining({ op: "listing.remove", ip: owner.jar.ip })]));
  });
});

describe("rejected listings reopened as drafts", () => {
  it("counts the reopened listing against the draft cap (409 draft_limit when 5 drafts exist)", async () => {
    const owner = await member();
    const rejected = await draft(owner);
    await updateListing(rejected, { status: "rejected", purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
    for (let i = 0; i < MAX_DRAFTS; i += 1) await draft(owner);

    const refused = await api<ErrorBody>(patch, "PATCH", `/api/listings/${rejected}`, { member: owner, body: { title: "Vélo de ville corrigé" } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("draft_limit");
    expect(await getListing(rejected)).toMatchObject({ status: "rejected", title: "" });

    // One draft fewer: the edit reopens it (purge clock stopped).
    const drafts = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine", { member: owner });
    expect((await api(remove, "DELETE", `/api/listings/${drafts.body.listings[0]!.id}`, { member: owner })).status).toBe(204);
    const reopened = await api<ListingBody>(patch, "PATCH", `/api/listings/${rejected}`, { member: owner, body: { title: "Vélo de ville corrigé" } });
    expect(reopened.status).toBe(200);
    expect(reopened.body.listing).toMatchObject({ status: "draft", title: "Vélo de ville corrigé" });
    // Back on the draft clock: 30 days from this edit, not the rejection's 12 months.
    expect((await getListing(rejected))!.purgeAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  it("reopens it on an empty save too (the wizard's reopen); the draft then writes nothing on one", async () => {
    const owner = await member();
    const rejected = await draft(owner);
    await updateListing(rejected, { status: "rejected", purgeAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) });
    const version = (await getListing(rejected))!.version;
    const reopened = await api<ListingBody>(patch, "PATCH", `/api/listings/${rejected}`, { member: owner, body: {} });
    expect(reopened.status).toBe(200);
    expect(reopened.body.listing).toMatchObject({ status: "draft", version: version + 1 });
    expect(await getListing(rejected)).toMatchObject({ status: "draft", version: version + 1 });
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${rejected}`, { member: owner, body: {} })).body.listing.version).toBe(version + 1);
  });
});
