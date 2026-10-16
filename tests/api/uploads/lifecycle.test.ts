import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Complete, status and deletion of uploads against the emulators (design §3 MEDIA_API, D12):
// inline pipeline without Valkey (EXIF/GPS stripped, variants published, photo attached to the
// draft), the size gate, the nudity refusal, owner-only access (404 for anyone else), deletion
// rules on drafts and live listings, and live listings left to the owner's PATCH.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
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

import { GET as getListingRoute } from "@/app/api/listings/[id]/route";
import { POST as complete } from "@/app/api/uploads/[id]/complete/route";
import { DELETE as remove, GET as status } from "@/app/api/uploads/[id]/route";
import { POST as publishListing } from "@/app/api/listings/[id]/publish/route";
import { POST as sign } from "@/app/api/uploads/sign/route";
import { MAX_UPLOAD_BYTES, type SignUploadResponse, type UploadStatusResponse } from "@/lib/contracts/media";
import type { ListingResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { getUpload } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import type * as Classify from "@/lib/media/classify";
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
    for (const variant of ["l", "s"]) {
      const body = (await store.get("media", `listings/${listingId}/${id}-${variant}.webp`))!;
      const meta = await sharp(body).metadata();
      expect([meta.format, meta.exif, meta.width, meta.height]).toEqual(["webp", undefined, 50, 100]);
    }

    const doc = (await getUpload(id))!;
    expect(doc).toMatchObject({ status: "ready", width: 50, height: 100, variants: ["l", "s"], checks: { nsfw: 0.02, faces: 0 } });
    expect((await getListing(listingId))!.photos).toEqual([{ id, w: 50, h: 100, blurhash: doc.blurhash, hash: doc.hash }]);
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
    const patched = await listingApi<ListingResponse>(patchListing, "PATCH", `/api/listings/${listingId}`, { member: owner, body: { photos: [...photoIds, id] } });
    expect(patched.status).toBe(200);
    expect((await getListing(listingId))!.photos.map((photo) => photo.id)).toEqual([...photoIds, id]);
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
    expect((await call(remove, "DELETE", `/api/uploads/${pair.photoIds[0]}`, { member: owner })).status).toBe(204);
    const listing = (await getListing(pair.id))!;
    expect(listing.photos.map((photo) => photo.id)).toEqual([pair.photoIds[1]]);
    expect(await getSearchOutbox(pair.id)).toMatchObject({ op: "upsert", version: listing.version });
  });
});
