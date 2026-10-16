import { describe, expect, it } from "vitest";
import { MAX_STAFF_PHOTO_BYTES, parseStaffPhotoParams, readStaffPhoto, staffPhotoPath, staffPhotoSources, usesStaffPhotos } from "@/app/admin/_lib/staff-photos";
import { photoFinalKey, photoObjectKey, retainedObjectKey } from "@/lib/media/urls";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { isValidObjectKey } from "@/lib/storage/keys";

// Photos of a removed listing live in the private bucket (removed/listings/...): the moderation
// review reads them through the staff-only route /photos/{listingId}/{photoId}/{variant}, private
// bucket first, then media (a listing removed within the hour, or a move cut short).

const LISTING = "abcd2345";
const PHOTO = "photo00000000001";

describe("retained photo keys", () => {
  it("keeps the media key under removed/ in the private bucket", () => {
    expect(retainedObjectKey(LISTING, PHOTO, "l")).toBe(`removed/listings/${LISTING}/${PHOTO}-l.webp`);
    expect(photoObjectKey("media", LISTING, PHOTO, "s")).toBe(`listings/${LISTING}/${PHOTO}-s.webp`);
    expect(photoObjectKey("private", LISTING, PHOTO, "s")).toBe(`removed/listings/${LISTING}/${PHOTO}-s.webp`);
    expect(photoFinalKey("media", LISTING, PHOTO)).toBe(`listings/${LISTING}/${PHOTO}`);
    expect(photoFinalKey("private", LISTING, PHOTO)).toBe(`removed/listings/${LISTING}/${PHOTO}`);
    expect(isValidObjectKey(retainedObjectKey(LISTING, PHOTO, "l"))).toBe(true);
    // Outside the backups/ prefix (98-day lifecycle rule of the private bucket).
    expect(retainedObjectKey(LISTING, PHOTO, "l").startsWith("backups/")).toBe(false);
  });
});

describe("staff photo route helpers", () => {
  it("only removed listings go through the staff route", () => {
    expect(usesStaffPhotos("removed")).toBe(true);
    for (const status of ["pending_review", "published", "paused", "sold", "expired", "rejected"] as const) expect(usesStaffPhotos(status)).toBe(false);
  });

  it("builds dot-free same-origin paths (proxy.ts skips paths with a dot) and both sources", () => {
    expect(staffPhotoPath(LISTING, PHOTO, "s")).toBe(`/photos/${LISTING}/${PHOTO}/s`);
    expect(staffPhotoPath(LISTING, PHOTO, "l")).not.toContain(".");
    const sources = staffPhotoSources(LISTING, { id: PHOTO, w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8" });
    expect(sources).toEqual({
      src: `/photos/${LISTING}/${PHOTO}/s`,
      srcSet: `/photos/${LISTING}/${PHOTO}/s 480w, /photos/${LISTING}/${PHOTO}/l 1600w`,
      width: 1600,
      height: 1200,
      large: `/photos/${LISTING}/${PHOTO}/l`,
    });
    expect(staffPhotoSources(LISTING, { id: PHOTO, w: 300, h: 200, blurhash: "LEHV6nWB2yk8" }, "l").srcSet).toBe(`/photos/${LISTING}/${PHOTO}/l 300w`);
  });

  it("accepts only valid ids and known variants", () => {
    expect(parseStaffPhotoParams({ listingId: LISTING, photoId: PHOTO, variant: "l" })).toEqual({ listingId: LISTING, photoId: PHOTO, variant: "l" });
    expect(parseStaffPhotoParams({ listingId: LISTING, photoId: PHOTO, variant: "xl" })).toBeNull();
    expect(parseStaffPhotoParams({ listingId: "ABCD2345", photoId: PHOTO, variant: "s" })).toBeNull();
    expect(parseStaffPhotoParams({ listingId: LISTING, photoId: "../../etc", variant: "s" })).toBeNull();
    expect(parseStaffPhotoParams({ listingId: LISTING, photoId: [PHOTO], variant: "s" })).toBeNull();
    expect(parseStaffPhotoParams({})).toBeNull();
  });

  it("reads the private bucket first, then media, null when neither holds the variant", async () => {
    const store = new MemoryObjectStore();
    const target = { listingId: LISTING, photoId: PHOTO, variant: "s" as const };
    expect(await readStaffPhoto(store, target)).toBeNull();
    expect(store.calls.map((call) => `${call.op} ${call.bucket} ${call.key}`)).toEqual([`get private removed/listings/${LISTING}/${PHOTO}-s.webp`, `get media listings/${LISTING}/${PHOTO}-s.webp`]);

    store.seed("media", photoObjectKey("media", LISTING, PHOTO, "s"), Buffer.from("public"), { contentType: "image/webp" });
    expect((await readStaffPhoto(store, target))?.toString()).toBe("public");
    store.seed("private", photoObjectKey("private", LISTING, PHOTO, "s"), Buffer.from("retained"), { contentType: "image/webp" });
    expect((await readStaffPhoto(store, target))?.toString()).toBe("retained");
  });

  it("refuses an object over the size guard", async () => {
    const store = new MemoryObjectStore();
    store.seed("private", photoObjectKey("private", LISTING, PHOTO, "l"), Buffer.alloc(MAX_STAFF_PHOTO_BYTES + 1), { contentType: "image/webp" });
    expect(await readStaffPhoto(store, { listingId: LISTING, photoId: PHOTO, variant: "l" })).toBeNull();
  });
});
