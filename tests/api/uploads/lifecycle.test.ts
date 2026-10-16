import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Complete, status and deletion of uploads against the emulators (design §3 MEDIA_API, D12):
// inline pipeline without Valkey (EXIF/GPS stripped, variants published, photo attached to the
// draft), the size gate, the nudity refusal, owner-only access (404 for anyone else), deletion
// rules on drafts and live listings (LCEN log, index and pages in the detach), live listings left
// to the owner's PATCH (an unsaved ready photo stays in the owner's view), sold and removed
// listings' photos retained, photos deleted under a legal hold kept as evidence but never offered
// again.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/listings/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof Revalidate>();
  return { ...actual, revalidateListingPaths: vi.fn(actual.revalidateListingPaths) };
});
vi.mock("@/lib/uploads/storage-gauge", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageGauge>();
  return { ...actual, recordMediaBytes: vi.fn(actual.recordMediaBytes) };
});
// Wrapped so a test can run a second DELETE of the same photo at a chosen point of the first (races).
vi.mock("@/lib/db/repositories/uploads", async (importOriginal) => {
  const actual = await importOriginal<typeof UploadsRepo>();
  return { ...actual, deleteUploadDocument: vi.fn(actual.deleteUploadDocument), transitionUpload: vi.fn(actual.transitionUpload) };
});
const classifier = vi.hoisted(() => ({ nsfw: 0.02, faces: 0, calls: 0, during: null as null | (() => Promise<void>) }));
vi.mock("@/lib/media/classify", async (importOriginal) => ({
  ...(await importOriginal<typeof Classify>()),
  imageClassifier: () => ({
    name: "fixture",
    classify: async () => {
      classifier.calls += 1;
      // Something else happens while the photo is being processed (races).
      await classifier.during?.();
      return { nsfw: classifier.nsfw, faces: classifier.faces };
    },
  }),
}));

import { DELETE as removeListing, GET as getListingRoute } from "@/app/api/listings/[id]/route";
import { POST as markSold } from "@/app/api/listings/[id]/sold/route";
import { POST as complete } from "@/app/api/uploads/[id]/complete/route";
import { DELETE as remove, GET as status } from "@/app/api/uploads/[id]/route";
import { POST as publishListing } from "@/app/api/listings/[id]/publish/route";
import { POST as sign } from "@/app/api/uploads/sign/route";
import { MAX_UPLOAD_BYTES, type SignUploadResponse, type UploadStatusResponse } from "@/lib/contracts/media";
import type { ListingResponse } from "@/lib/contracts/listings";
import { listContentOps } from "@/lib/db/repositories/content-ops";
import { getListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox, searchOutboxRef } from "@/lib/db/repositories/search-outbox";
import { deleteUploadDocument, getUpload, sumStoredBytes, transitionUpload } from "@/lib/db/repositories/uploads";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import type * as Classify from "@/lib/media/classify";
import type * as Revalidate from "@/lib/listings/revalidate";
import type * as StorageGauge from "@/lib/uploads/storage-gauge";
import type * as UploadsRepo from "@/lib/db/repositories/uploads";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { sharp } from "@/lib/media/sharp-setup";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { attachPhoto, call, draft, exifGpsJpeg, listingApi, member, patchListing, plainJpeg, publishedListing, readyPatch, seedReadyUpload, type ErrorBody, type Member } from "./helpers";

const store = new MemoryObjectStore();

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  store.clear();
  classifier.nsfw = 0.02;
  classifier.faces = 0;
  classifier.calls = 0;
  classifier.during = null;
});

/** sign -> the browser's PUT (seeded into the store) -> the upload id. */
async function uploaded(owner: Member, listingId: string, file?: Buffer, declaredSize?: number): Promise<string> {
  const body = file ?? (await plainJpeg());
  const signed = await call<SignUploadResponse>(sign, "POST", "/api/uploads/sign", {
    member: owner,
    body: { purpose: "listing", targetId: listingId, declaredSize: declaredSize ?? body.byteLength, declaredType: "image/jpeg" },
  });
  expect(signed.status).toBe(201);
  store.seed("quarantine", `uploads/${signed.body.uploadId}`, body, { contentType: "image/jpeg" });
  return signed.body.uploadId;
}

const completeAs = (owner: Member | undefined, id: string, options: { csrf?: boolean; body?: unknown } = {}) =>
  call<UploadStatusResponse & ErrorBody>(complete, "POST", `/api/uploads/${id}/complete`, { member: owner, body: "body" in options ? options.body : {}, csrf: options.csrf });

describe("POST /api/uploads/{id}/complete (inline pipeline)", () => {
  it("publishes metadata-free variants, attaches the photo to the draft and answers ready", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId, await exifGpsJpeg());

    const done = await completeAs(owner, id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "ready", photo: { id, w: 50, h: 100 } });
    expect(store.has("quarantine", `uploads/${id}`)).toBe(false);
    for (const variant of ["l", "m", "s"]) {
      const body = (await store.get("media", `listings/${listingId}/${id}-${variant}.webp`))!;
      const meta = await sharp(body).metadata();
      expect([meta.format, meta.exif, meta.width, meta.height]).toEqual(["webp", undefined, 50, 100]);
    }

    const doc = (await getUpload(id))!;
    expect(doc).toMatchObject({ status: "ready", width: 50, height: 100, variants: ["l", "m", "s"], checks: { nsfw: 0.02, faces: 0 } });
    expect((await getListing(listingId))!.photos).toEqual([{ id, w: 50, h: 100, blurhash: doc.blurhash, hash: doc.hash, variants: ["l", "m", "s"] }]);
    const owned = await listingApi<ListingResponse>(getListingRoute, "GET", `/api/listings/${listingId}`, { member: owner });
    expect(owned.body.listing.photos).toEqual([{ id, status: "ready", w: 50, h: 100, blurhash: doc.blurhash }]);

    // Repeating complete changes nothing; GET answers the same.
    const calls = store.calls.length;
    expect((await completeAs(owner, id)).body).toEqual(done.body);
    expect((await call<UploadStatusResponse>(status, "GET", `/api/uploads/${id}`, { member: owner })).body).toEqual(done.body);
    expect(store.calls.length).toBe(calls);
    expect(classifier.calls).toBe(1);
  });

  it("accepts a call without a body, and refuses an unexpected one", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    expect((await completeAs(owner, id, { body: { force: true } })).status).toBe(400);
    const done = await call<UploadStatusResponse>(complete, "POST", `/api/uploads/${id}/complete`, { member: owner });
    expect(done.body.status).toBe("ready");
  });

  it("deletes an object above 10 MB before reading it (too_large)", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId, Buffer.alloc(MAX_UPLOAD_BYTES + 10, 0xff), MAX_UPLOAD_BYTES);
    const done = await completeAs(owner, id);
    expect(done.body).toEqual({ status: "rejected", rejectReason: "too_large" });
    expect(store.opsFor("quarantine", `uploads/${id}`)).toEqual(["presignPut", "head", "delete"]);
    expect(await getUpload(id)).toMatchObject({ status: "rejected", rejectReason: "too_large", size: MAX_UPLOAD_BYTES + 10 });
    expect((await getListing(listingId))!.photos).toEqual([]);
    expect((await call<UploadStatusResponse>(status, "GET", `/api/uploads/${id}`, { member: owner })).body).toEqual({ status: "rejected", rejectReason: "too_large" });
  });

  it("expires an upload completed without its PUT", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const signed = await call<SignUploadResponse>(sign, "POST", "/api/uploads/sign", { member: owner, body: { purpose: "listing", targetId: listingId, declaredSize: 1000, declaredType: "image/jpeg" } });
    expect((await completeAs(owner, signed.body.uploadId)).body).toEqual({ status: "rejected", rejectReason: "expired" });
  });

  it("refuses a photo at the nudity threshold and records the statement of reasons", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    classifier.nsfw = 0.93;
    expect((await completeAs(owner, id)).body).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(store.keys("media")).toEqual([]);
    expect((await getListing(listingId))!.photos).toEqual([]);
    const decisions = await db().collection(COLLECTIONS.moderationDecisions).where("target.id", "==", id).get();
    expect(decisions.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({ target: { type: "upload", id }, affectedUid: owner.uid, action: "remove", decidedBy: "system", automation: { detection: true, decision: true } }),
    ]);
  });

  it("keeps the review band and faces on the upload for the listing screening", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    classifier.nsfw = 0.7;
    classifier.faces = 1;
    expect((await completeAs(owner, id)).body.status).toBe("ready");
    expect((await getUpload(id))!.checks).toEqual({ nsfw: 0.7, faces: 1 });
  });

  it("does not attach to a published listing: the owner's PATCH does, with the re-screening", async () => {
    const owner = await member();
    const { id: listingId, photoIds } = await publishedListing(owner, 1);
    const id = await uploaded(owner, listingId);
    expect((await completeAs(owner, id)).body.status).toBe("ready");
    expect((await getListing(listingId))!.photos.map((photo) => photo.id)).toEqual(photoIds);
    // Reloaded before saving: the ready photo is still offered (as processing: the wizard polls
    // it, then puts it in the next save) instead of vanishing until purge-quarantine deletes it.
    const reloaded = await listingApi<ListingResponse>(getListingRoute, "GET", `/api/listings/${listingId}`, { member: owner });
    expect(reloaded.body.listing.photos.map((photo) => [photo.id, photo.status])).toEqual([
      [photoIds[0], "ready"],
      [id, "processing"],
    ]);
    expect((await call<UploadStatusResponse>(status, "GET", `/api/uploads/${id}`, { member: owner })).body.status).toBe("ready");
    const patched = await listingApi<ListingResponse>(patchListing, "PATCH", `/api/listings/${listingId}`, { member: owner, body: { photos: [...photoIds, id] } });
    expect(patched.status).toBe(200);
    expect((await getListing(listingId))!.photos.map((photo) => photo.id)).toEqual([...photoIds, id]);
    expect(patched.body.listing.photos.map((photo) => [photo.id, photo.status])).toEqual([
      [photoIds[0], "ready"],
      [id, "ready"],
    ]);
  });

  it("keeps an unsaved ready photo out of a draft's view (the pipeline attaches there) and under a legal hold", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const detached = await seedReadyUpload(owner, listingId);
    const view = await listingApi<ListingResponse>(getListingRoute, "GET", `/api/listings/${listingId}`, { member: owner });
    expect(view.body.listing.photos).toEqual([]);

    const live = await publishedListing(owner, 1, { title: "Lampe de bureau en laiton" });
    const unsaved = await seedReadyUpload(owner, live.id);
    await db().collection(COLLECTIONS.listings).doc(live.id).update({ legalHold: ["requisition-1"] });
    const held = await listingApi<ListingResponse>(getListingRoute, "GET", `/api/listings/${live.id}`, { member: owner });
    expect(held.body.listing.photos.map((photo) => photo.id)).toEqual(live.photoIds);
    expect([detached, unsaved].every((id) => !held.body.listing.photos.some((photo) => photo.id === id))).toBe(true);
  });
});

describe("races between the pipeline and the other routes", () => {
  it("does not attach a photo to a draft published while it was processing", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const first = await seedReadyUpload(owner, listingId);
    expect((await listingApi(patchListing, "PATCH", `/api/listings/${listingId}`, { member: owner, body: { ...readyPatch(), photos: [first] } })).status).toBe(200);
    const id = await uploaded(owner, listingId);
    classifier.during = async () => {
      const published = await listingApi<{ status: string }>(publishListing, "POST", `/api/listings/${listingId}/publish`, { member: owner, body: { acceptRules: true } });
      expect(published.body.status).toBe("published");
    };
    expect((await completeAs(owner, id)).body.status).toBe("ready");
    const listing = (await getListing(listingId))!;
    expect([listing.status, listing.photos.map((photo) => photo.id)]).toEqual(["published", [first]]);
    expect((await getUpload(id))!.status).toBe("ready");
  });

  it("removes what an in-flight run stored when its upload is deleted meanwhile", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    let deleted = 0;
    classifier.during = async () => {
      deleted = (await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status;
    };
    expect((await completeAs(owner, id)).status).toBe(404);
    expect(deleted).toBe(204);
    expect(await getUpload(id)).toBeNull();
    expect((await getListing(listingId))!.photos).toEqual([]);
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("quarantine")).toEqual([]);
  });

  it("lets only one of two photos completed together take the last free slot of a draft", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    for (let i = 0; i < 8; i += 1) await attachPhoto(listingId, await seedReadyUpload(owner, listingId));
    const a = await uploaded(owner, listingId);
    const b = await uploaded(owner, listingId);
    // A 9th photo arrives through another path after both signatures (the sign check passed).
    await attachPhoto(listingId, await seedReadyUpload(owner, listingId));
    const results = await Promise.all([completeAs(owner, a), completeAs(owner, b)]);
    expect(results.map((result) => result.body.status).sort()).toEqual(["ready", "rejected"]);
    expect(results.find((result) => result.body.status === "rejected")!.body).toEqual({ status: "rejected", rejectReason: "quota" });
    const listing = (await getListing(listingId))!;
    expect(listing.photos).toHaveLength(10);
    // The refused photo left nothing behind in the media bucket.
    const refused = results.find((result) => result.body.status === "rejected") === results[0] ? a : b;
    expect(store.keys("media").filter((key) => key.includes(refused))).toEqual([]);
  });
});

describe("owner-only access to /api/uploads/{id}", () => {
  it("answers 404 to anyone else, 401 anonymous, 403 without CSRF, 404 for a malformed id", async () => {
    const owner = await member();
    const stranger = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);

    expect((await completeAs(stranger, id)).status).toBe(404);
    expect((await call(status, "GET", `/api/uploads/${id}`, { member: stranger })).status).toBe(404);
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: stranger })).status).toBe(404);
    expect((await completeAs(undefined, id)).status).toBe(401);
    expect((await call(status, "GET", `/api/uploads/${id}`)).status).toBe(401);
    const noCsrf = await completeAs(owner, id, { csrf: false });
    expect([noCsrf.status, noCsrf.body.error.code]).toEqual([403, "csrf"]);
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner, csrf: false })).status).toBe(403);
    expect((await call(status, "GET", "/api/uploads/not-an-id!", { member: owner })).status).toBe(404);
    expect((await call(status, "GET", "/api/uploads/zzzzzzzzzzzzzzzz", { member: owner })).status).toBe(404);

    // Nothing ran for the intruders: the upload is still waiting for its owner.
    expect((await getUpload(id))!.status).toBe("signed");
    expect((await call<UploadStatusResponse>(status, "GET", `/api/uploads/${id}`, { member: owner })).body).toEqual({ status: "processing" });
  });
});

describe("DELETE /api/uploads/{id}", () => {
  it("detaches the photo from the draft, deletes the variants and the document", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    expect((await completeAs(owner, id)).body.status).toBe("ready");

    const deleted = await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner });
    expect(deleted.status).toBe(204);
    expect((await getListing(listingId))!.photos).toEqual([]);
    expect(await getUpload(id)).toBeNull();
    expect(store.keys("media")).toEqual([]);
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(404);
  });

  it("deletes an upload still waiting for its PUT", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(204);
    expect(store.has("quarantine", `uploads/${id}`)).toBe(false);
    expect(await getUpload(id)).toBeNull();
  });

  it("keeps the last photo of a published listing (422) and indexes the change otherwise", async () => {
    const owner = await member();
    const single = await publishedListing(owner, 1);
    const refused = await call<ErrorBody & { error: { details: unknown } }>(remove, "DELETE", `/api/uploads/${single.photoIds[0]}`, { member: owner });
    expect([refused.status, refused.body.error.code]).toEqual([422, "invalid_listing"]);
    expect(refused.body.error.details).toEqual([{ path: "photos", code: "photos_required" }]);
    expect((await getListing(single.id))!.photos).toHaveLength(1);

    const pair = await publishedListing(owner, 2, { title: "Vélo de course Btwin très bon état" });
    vi.mocked(revalidateListingPaths).mockClear();
    expect((await call(remove, "DELETE", `/api/uploads/${pair.photoIds[0]}`, { member: owner })).status).toBe(204);
    const listing = (await getListing(pair.id))!;
    expect(listing.photos.map((photo) => photo.id)).toEqual([pair.photoIds[1]]);
    expect(await getSearchOutbox(pair.id)).toMatchObject({ op: "upsert", version: listing.version });
    // LCEN: the change of a public listing is logged like a PATCH, with the IP in clear.
    expect((await listContentOps(`listings/${pair.id}`)).filter((op) => op.op === "listing.update")).toEqual([expect.objectContaining({ uid: owner.uid, ip: owner.jar.ip })]);
    expect(revalidateListingPaths).toHaveBeenCalledWith({ slugId: listing.slugId, publicId: listing.sellerPublicId });
  });

  it("logs and revalidates the change on the other editable public statuses (paused, expired), indexing published ones only", async () => {
    const owner = await member();
    for (const [index, state] of (["paused", "expired"] as const).entries()) {
      const listed = await publishedListing(owner, 2, { title: `Chaise en bois massif numéro ${index + 1}` });
      await db().collection(COLLECTIONS.listings).doc(listed.id).update({ status: state });
      await searchOutboxRef(listed.id).delete();
      const before = (await listContentOps(`listings/${listed.id}`)).length;
      vi.mocked(revalidateListingPaths).mockClear();

      expect((await call(remove, "DELETE", `/api/uploads/${listed.photoIds[0]}`, { member: owner })).status, state).toBe(204);
      const listing = (await getListing(listed.id))!;
      expect(listing.photos.map((photo) => photo.id)).toEqual([listed.photoIds[1]]);
      const ops = await listContentOps(`listings/${listed.id}`);
      expect(ops).toHaveLength(before + 1);
      expect(ops[ops.length - 1]).toMatchObject({ op: "listing.update", uid: owner.uid, ip: owner.jar.ip });
      expect(revalidateListingPaths).toHaveBeenCalledWith({ slugId: listing.slugId, publicId: listing.sellerPublicId });
      // Not in the index: no search entry.
      expect(await getSearchOutbox(listed.id)).toBeNull();
    }
  });

  it("writes no log, index entry or revalidation for a draft", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const id = await uploaded(owner, listingId);
    expect((await completeAs(owner, id)).body.status).toBe("ready");
    vi.mocked(revalidateListingPaths).mockClear();
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(204);
    expect(await listContentOps(`listings/${listingId}`)).toEqual([expect.objectContaining({ op: "listing.create" })]);
    expect(await getSearchOutbox(listingId)).toBeNull();
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("keeps the photos of a removed listing with it (retained until its purge): 409, nothing deleted", async () => {
    const owner = await member();
    const listed = await publishedListing(owner, 2, { title: "Table basse en chêne clair" });
    expect((await listingApi(removeListing, "DELETE", `/api/listings/${listed.id}`, { member: owner })).status).toBe(204);
    const refused = await call<ErrorBody>(remove, "DELETE", `/api/uploads/${listed.photoIds[0]}`, { member: owner });
    expect([refused.status, refused.body.error.code]).toEqual([409, "conflict"]);
    expect((await getListing(listed.id))!.photos.map((photo) => photo.id)).toEqual(listed.photoIds);
    expect(await getUpload(listed.photoIds[0]!)).not.toBeNull();
  });

  it("keeps the photos of a sold listing (read-only, retained 12 months with its text): 409, nothing changes", async () => {
    const owner = await member();
    const listed = await publishedListing(owner, 2, { title: "Commode ancienne en noyer" });
    expect((await listingApi(markSold, "POST", `/api/listings/${listed.id}/sold`, { member: owner })).status).toBe(200);
    const unsaved = await seedReadyUpload(owner, listed.id, { status: "rejected", rejectReason: "nsfw" });
    const before = (await getListing(listed.id))!;
    const opsBefore = (await listContentOps(`listings/${listed.id}`)).length;
    vi.mocked(revalidateListingPaths).mockClear();
    store.calls.length = 0;

    for (const id of [listed.photoIds[0]!, unsaved]) {
      const refused = await call<ErrorBody>(remove, "DELETE", `/api/uploads/${id}`, { member: owner });
      expect([refused.status, refused.body.error.code], id).toEqual([409, "conflict"]);
      expect(await getUpload(id), id).not.toBeNull();
    }
    const after = (await getListing(listed.id))!;
    expect([after.status, after.version, after.photos]).toEqual(["sold", before.version, before.photos]);
    expect((await getUpload(listed.photoIds[0]!))!.status).toBe("ready");
    expect(await listContentOps(`listings/${listed.id}`)).toHaveLength(opsBefore);
    expect(revalidateListingPaths).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });
});

describe("DELETE /api/uploads/{id} under a legal hold", () => {
  it("detaches the photo and ends the upload but keeps its document and objects; it is never offered again", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 2, { title: "Lampadaire en laiton doré" });
    const [held, kept] = live.photoIds as [string, string];
    for (const variant of ["l", "s"]) store.seed("media", `listings/${live.id}/${held}-${variant}.webp`, Buffer.from("webp"), { contentType: "image/webp" });
    await db().collection(COLLECTIONS.listings).doc(live.id).update({ legalHold: ["requisition-1"] });
    store.calls.length = 0;

    const bytesBefore = await sumStoredBytes();
    const heldSize = (await getUpload(held))!.size!;
    expect(heldSize).toBeGreaterThan(0);
    vi.mocked(recordMediaBytes).mockClear();
    expect((await call(remove, "DELETE", `/api/uploads/${held}`, { member: owner })).status).toBe(204);
    expect(recordMediaBytes).not.toHaveBeenCalled();
    expect((await getListing(live.id))!.photos.map((photo) => photo.id)).toEqual([kept]);
    expect(await getUpload(held)).toMatchObject({ status: "rejected", rejectReason: "expired", variants: ["l", "s"], heldObjects: true });
    // Its variants are still stored: the gauge's nightly recount keeps counting them.
    expect(await sumStoredBytes()).toBe(bytesBefore);
    // Evidence: nothing deleted in either bucket.
    expect(store.calls.filter((entry) => entry.op === "delete")).toEqual([]);
    expect(store.keys("media").filter((key) => key.includes(held))).toHaveLength(2);

    // An upload still waiting for its PUT ends too: completing it later cannot make it a photo.
    const pending = await uploaded(owner, live.id);
    expect((await call(remove, "DELETE", `/api/uploads/${pending}`, { member: owner })).status).toBe(204);
    expect((await completeAs(owner, pending)).body).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(await getUpload(pending)).not.toBeNull();
    // Nothing was stored for it: not counted.
    expect((await getUpload(pending))!.heldObjects).toBeUndefined();

    const photosOf = async () => (await listingApi<ListingResponse>(getListingRoute, "GET", `/api/listings/${live.id}`, { member: owner })).body.listing.photos.map((photo) => [photo.id, photo.status]);
    const expected = [
      [kept, "ready"],
      [held, "rejected"],
      [pending, "rejected"],
    ];
    expect(await photosOf()).toEqual(expected);
    // Hold lifted: the deleted photo is not offered for the next save (it read as an unsaved
    // `processing` photo before), and a save naming it does not attach it.
    await db().collection(COLLECTIONS.listings).doc(live.id).update({ legalHold: [] });
    expect(await photosOf()).toEqual(expected);
    expect((await listingApi(patchListing, "PATCH", `/api/listings/${live.id}`, { member: owner, body: { photos: [kept, held] } })).status).toBe(200);
    expect((await getListing(live.id))!.photos.map((photo) => photo.id)).toEqual([kept]);

    // After the hold, deleting it again removes the objects and the document, and its bytes.
    expect((await call(remove, "DELETE", `/api/uploads/${held}`, { member: owner })).status).toBe(204);
    expect(await getUpload(held)).toBeNull();
    expect(await sumStoredBytes()).toBe(bytesBefore - heldSize);
    expect(recordMediaBytes).toHaveBeenCalledExactlyOnceWith(-heldSize, expect.any(Date));
    expect(store.keys("media").filter((key) => key.includes(held))).toEqual([]);
  });
});

describe("DELETE /api/uploads/{id} twice at once (a retry, a double tap)", () => {
  const actual = () => vi.importActual<typeof UploadsRepo>("@/lib/db/repositories/uploads");

  it("gives the bytes of a photo back to the storage gauge once, whichever request removes the document", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 3, { title: "Commode en cèdre sculpté" });
    const [ready, held] = live.photoIds as [string, string, string];
    const sizes = { ready: (await getUpload(ready))!.size!, held: (await getUpload(held))!.size! };
    // `held` is deleted under a hold, then the hold is lifted: its variants are still counted.
    await db().collection(COLLECTIONS.listings).doc(live.id).update({ legalHold: ["requisition-1"] });
    expect((await call(remove, "DELETE", `/api/uploads/${held}`, { member: owner })).status).toBe(204);
    await db().collection(COLLECTIONS.listings).doc(live.id).update({ legalHold: [] });
    const bytesBefore = await sumStoredBytes();
    const { deleteUploadDocument: removeDocument } = await actual();
    vi.mocked(recordMediaBytes).mockClear();

    for (const id of [held, ready]) {
      // The second request runs to its end while the first is about to remove the document.
      vi.mocked(deleteUploadDocument).mockImplementationOnce(async (photoId) => {
        expect((await call(remove, "DELETE", `/api/uploads/${photoId}`, { member: owner })).status).toBe(204);
        return removeDocument(photoId);
      });
      expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(204);
      expect(await getUpload(id)).toBeNull();
    }
    // `held`: removed by the second request, still counted then. `ready`: the first request took it
    // out of `ready`, the second found it ended and freed nothing.
    expect(vi.mocked(recordMediaBytes).mock.calls).toEqual([
      [-sizes.held, expect.any(Date)],
      [-sizes.ready, expect.any(Date)],
    ]);
    expect(await sumStoredBytes()).toBe(bytesBefore - sizes.ready - sizes.held);
  });

  it("frees nothing in the request that lost the transition out of `ready`", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 2, { title: "Pouf en cuir de Fès" });
    const [photo] = live.photoIds as [string, string];
    const { transitionUpload: transition } = await actual();
    vi.mocked(recordMediaBytes).mockClear();
    // Both requests read the photo `ready`; the other one ends it first, before this one's transition.
    vi.mocked(transitionUpload).mockImplementationOnce(async (...args) => {
      expect((await transition(photo, ["ready"], { status: "rejected", rejectReason: "expired" })).ok).toBe(true);
      return transition(...args);
    });

    expect((await call(remove, "DELETE", `/api/uploads/${photo}`, { member: owner })).status).toBe(204);
    expect(await getUpload(photo)).toBeNull();
    // The other request's transition took the bytes: this one gives none back.
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/uploads/{id} cut short by a storage error", () => {
  it("takes the bytes off with the transition: the retry that removes the objects and the document frees nothing more", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 2, { title: "Lanterne en laiton ciselé" });
    const [photo] = live.photoIds as [string, string];
    const size = (await getUpload(photo))!.size!;
    const bytesBefore = await sumStoredBytes();
    vi.mocked(recordMediaBytes).mockClear();
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("storage unavailable"));

    expect((await call(remove, "DELETE", `/api/uploads/${photo}`, { member: owner })).status).toBe(500);
    expect((await getUpload(photo))!.status).toBe("rejected");
    // Off the gauge already, as the nightly recount sees it.
    expect(await sumStoredBytes()).toBe(bytesBefore - size);
    expect(recordMediaBytes).toHaveBeenCalledExactlyOnceWith(-size, expect.any(Date));

    expect((await call(remove, "DELETE", `/api/uploads/${photo}`, { member: owner })).status).toBe(204);
    expect(await getUpload(photo)).toBeNull();
    expect(store.keys("media").filter((key) => key.includes(photo))).toEqual([]);
    expect(recordMediaBytes).toHaveBeenCalledOnce();
  });
});

describe("deleteUploadDocument", () => {
  it("returns the document it removed, then null: one caller removes it", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 1, { title: "Théière en argent ciselé" });
    const [photo] = live.photoIds as [string];
    const { deleteUploadDocument: removeDocument } = await vi.importActual<typeof UploadsRepo>("@/lib/db/repositories/uploads");
    const removed = await Promise.all([removeDocument(photo), removeDocument(photo)]);
    expect(removed.filter(Boolean)).toEqual([expect.objectContaining({ id: photo, status: "ready" })]);
    expect(removed.filter((record) => record === null)).toHaveLength(1);
    expect(await getUpload(photo)).toBeNull();
  });
});

describe("DELETE /api/uploads/{id} of an orphan photo moved to the private bucket", () => {
  it("deletes its variants from the private bucket and any public copy left by a move cut short", async () => {
    const owner = await member();
    const live = await publishedListing(owner, 2, { title: "Commode ancienne en noyer" });
    const [moved] = live.photoIds as [string];
    for (const variant of ["l", "s"]) {
      store.seed("private", `removed/listings/${live.id}/${moved}-${variant}.webp`, Buffer.from("webp"), { contentType: "image/webp" });
      store.seed("media", `listings/${live.id}/${moved}-${variant}.webp`, Buffer.from("webp"), { contentType: "image/webp" });
    }
    await db().collection(COLLECTIONS.uploads).doc(moved).update({ bucket: "private", finalKey: `removed/listings/${live.id}/${moved}` });
    await db().collection(COLLECTIONS.listings).doc(live.id).delete();

    expect((await call(remove, "DELETE", `/api/uploads/${moved}`, { member: owner })).status).toBe(204);
    expect(await getUpload(moved)).toBeNull();
    expect(store.keys("private").filter((key) => key.includes(moved))).toEqual([]);
    expect(store.keys("media").filter((key) => key.includes(moved))).toEqual([]);
  });
});
