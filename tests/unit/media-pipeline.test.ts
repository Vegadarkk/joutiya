import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingPhoto } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// Pipeline of a listing photo (design §4 media/pipeline.ts, exit criteria §6) on generated
// fixtures: a MemoryObjectStore records every storage call (size gate before any GET), the
// StubImageClassifier drives the nudity paths, and in-memory fakes stand for the uploads and
// listings repositories (their transactions are covered by the API tests on the emulator).

const fake = vi.hoisted(() => {
  class PhotoLimitError extends Error {
    constructor() {
      super("photo limit reached");
      this.name = "PhotoLimitError";
    }
  }
  return {
    uploads: new Map<string, unknown>(),
    listings: new Map<string, unknown>(),
    PhotoLimitError,
    attachFailures: [] as Error[],
    readyWriteResult: null as null | { ok: false; upload: unknown },
  };
});

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
vi.mock("@/lib/db/repositories/moderation-decisions", () => ({ recordModerationDecision: vi.fn(async () => "decision-1") }));
vi.mock("@/lib/db/repositories/uploads", () => ({
  getUpload: vi.fn(async (id: string) => structuredClone(fake.uploads.get(id) ?? null)),
  transitionUpload: vi.fn(async (id: string, from: readonly string[], patch: Record<string, unknown>, now: Date) => {
    const current = fake.uploads.get(id) as Record<string, unknown> | undefined;
    if (patch.status === "ready" && fake.readyWriteResult) return fake.readyWriteResult;
    if (!current || !from.includes(current.status as string)) return { ok: false, upload: current ? structuredClone(current) : null };
    const next: Record<string, unknown> = { ...current, updatedAt: now };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    fake.uploads.set(id, next);
    return { ok: true, upload: structuredClone(next) };
  }),
}));
vi.mock("@/lib/db/repositories/listings", () => ({
  PhotoLimitError: fake.PhotoLimitError,
  getListing: vi.fn(async (id: string) => structuredClone(fake.listings.get(id) ?? null)),
  attachReadyPhoto: vi.fn(async (listingId: string, photo: { id: string }, options: { maxPhotos: number }) => {
    const failure = fake.attachFailures.shift();
    if (failure) throw failure;
    const listing = fake.listings.get(listingId) as { photos: { id: string }[] } | undefined;
    if (!listing) return null;
    const index = listing.photos.findIndex((item) => item.id === photo.id);
    if (index >= 0) listing.photos[index] = photo;
    else {
      if (listing.photos.length >= options.maxPhotos) throw new fake.PhotoLimitError();
      listing.photos.push(photo);
    }
    return structuredClone(listing);
  }),
  removePhoto: vi.fn(async (listingId: string, photoId: string) => {
    const listing = fake.listings.get(listingId) as { photos: { id: string }[] } | undefined;
    if (!listing) return null;
    listing.photos = listing.photos.filter((item) => item.id !== photoId);
    return structuredClone(listing);
  }),
}));

const { expireUpload, processUpload } = await import("@/lib/media/pipeline");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { StubImageClassifier } = await import("@/lib/media/classify");
const { sharp } = await import("@/lib/media/sharp-setup");
const { attachReadyPhoto, removePhoto } = await import("@/lib/db/repositories/listings");
const { recordModerationDecision } = await import("@/lib/db/repositories/moderation-decisions");
const { recordMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE } = await import("@/lib/media/urls");
const { MAX_UPLOAD_BYTES } = await import("@/lib/contracts/media");

const LISTING_ID = "abcdefgh";
const NOW = new Date("2026-10-16T10:00:00Z");
const clean = () => new StubImageClassifier({ nsfw: 0.02, faces: 0 });

let store: InstanceType<typeof MemoryObjectStore>;
let counter = 0;

function upload(overrides: Partial<UploadRecord> = {}): UploadRecord {
  counter += 1;
  const id = overrides.id ?? `upl${String(counter).padStart(5, "0")}abcdefgh`;
  const record: UploadRecord = {
    id,
    ownerUid: "owner-1",
    purpose: "listing",
    targetId: LISTING_ID,
    declaredSize: 2 * 1024 * 1024,
    declaredType: "image/jpeg",
    status: "processing",
    quarantineKey: `uploads/${id}`,
    bucket: "media",
    checks: {},
    purgeAt: new Date(NOW.getTime() + 7 * 86_400_000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  fake.uploads.set(id, structuredClone(record));
  return record;
}

function listing(overrides: Partial<ListingRecord> = {}): void {
  fake.listings.set(overrides.id ?? LISTING_ID, { id: LISTING_ID, ownerUid: "owner-1", status: "draft", sellerType: "individual", photos: [], legalHold: [], ...overrides });
}

const photo = (id: string): ListingPhoto => ({ id, w: 100, h: 100, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" });
const stored = (id: string) => fake.uploads.get(id) as UploadRecord;
const keyL = (id: string) => `listings/${LISTING_ID}/${id}-l.webp`;
const keyS = (id: string) => `listings/${LISTING_ID}/${id}-s.webp`;

function seed(record: UploadRecord, body: Buffer, contentType: string = record.declaredType): void {
  store.seed("quarantine", record.quarantineKey, body, { contentType });
}

async function exifGpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Joutiya test", Model: "Fixture" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 35/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "7/1 36/1 0/1" },
    })
    .toBuffer();
}

/** Photo-like noise: realistic sizes and a truncation that only the decode notices. */
const noisyJpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 40 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

const plainJpeg = (width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 60 } } }).jpeg().toBuffer();

/** A PNG whose header announces width x height over a few bytes of data (decompression bomb). */
function pngBomb(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))), chunk("IEND", Buffer.alloc(0))]);
}

beforeEach(() => {
  fake.uploads.clear();
  fake.listings.clear();
  fake.attachFailures.length = 0;
  fake.readyWriteResult = null;
  store = new MemoryObjectStore();
  vi.mocked(attachReadyPhoto).mockClear();
  vi.mocked(removePhoto).mockClear();
  vi.mocked(recordModerationDecision).mockClear();
  vi.mocked(recordMediaBytes).mockClear();
  listing();
});

describe("processUpload: happy path", () => {
  it("publishes metadata-free, oriented WebP variants, attaches the photo to the draft and deletes the original", async () => {
    const record = upload();
    seed(record, await exifGpsJpeg());
    const classifier = new StubImageClassifier({ nsfw: 0.1, faces: 1 });
    const result = await processUpload(record.id, { store, classifier, now: () => NOW });

    expect(result).toMatchObject({ status: "ready", photo: { id: record.id, w: 50, h: 100 } });
    // Quarantine: size first, then the read, then the deletion (last: retries redo the run).
    expect(store.opsFor("quarantine", record.quarantineKey)).toEqual(["head", "get", "delete"]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(store.keys("media")).toEqual([keyL(record.id), keyS(record.id)]);
    for (const key of [keyL(record.id), keyS(record.id)]) {
      const body = (await store.get("media", key))!;
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([50, 100]);
      expect(body.includes("Joutiya test")).toBe(false);
      expect(await store.head("media", key)).toMatchObject({ contentType: MEDIA_CONTENT_TYPE });
    }
    expect(classifier.calls).toBe(1);

    const doc = stored(record.id);
    const bytes = (await store.get("media", keyL(record.id)))!.byteLength + (await store.get("media", keyS(record.id)))!.byteLength;
    expect(doc).toMatchObject({ status: "ready", width: 50, height: 100, size: bytes, variants: ["l", "s"], checks: { nsfw: 0.1, faces: 1 }, finalKey: `listings/${LISTING_ID}/${record.id}` });
    expect(doc.blurhash).toMatch(/^.{6,}$/);
    expect(doc.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(attachReadyPhoto).toHaveBeenCalledWith(LISTING_ID, { id: record.id, w: 50, h: 100, blurhash: doc.blurhash, hash: doc.hash }, { maxPhotos: 10, now: NOW });
    expect(recordMediaBytes).toHaveBeenCalledWith(bytes, NOW);
    expect(recordModerationDecision).not.toHaveBeenCalled();
  });

  it("stores the variants with the media type and the immutable cache policy", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    const puts: { key: string; contentType: string; cacheControl?: string }[] = [];
    const spy = vi.spyOn(store, "put").mockImplementation(async (bucket, key, body, options) => {
      puts.push({ key, ...options });
      store.seed(bucket, key, body, options);
    });
    await processUpload(record.id, { store, classifier: clean() });
    expect(puts).toEqual([
      { key: keyL(record.id), contentType: MEDIA_CONTENT_TYPE, cacheControl: MEDIA_CACHE_CONTROL },
      { key: keyS(record.id), contentType: MEDIA_CONTENT_TYPE, cacheControl: MEDIA_CACHE_CONTROL },
    ]);
    spy.mockRestore();
  });

  it("re-encodes a polyglot JPEG without its trailer", async () => {
    const record = upload();
    const trailer = Buffer.from("PK\u0003\u0004<?php system($_GET[0]); ?><script>alert(1)</script>", "latin1");
    seed(record, Buffer.concat([await plainJpeg(320, 240), trailer]));
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready" });
    for (const key of store.keys("media")) {
      const body = (await store.get("media", key))!;
      expect(body.includes("<?php")).toBe(false);
      expect(body.includes("PK\u0003\u0004", 0, "latin1")).toBe(false);
    }
  });

  it("does not attach to a live listing (the owner's PATCH re-screens it) but still answers ready", async () => {
    listing({ status: "published", photos: [photo("existing1")] });
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready" });
    expect(attachReadyPhoto).not.toHaveBeenCalled();
    expect(stored(record.id).status).toBe("ready");
  });

  it("does not store the zeros of the stand-in classifier as checks (models missing)", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    // No classifier injected: the factory falls back to the stub (no model files in tests).
    expect(await processUpload(record.id, { store })).toMatchObject({ status: "ready" });
    expect(stored(record.id).checks).toEqual({});
  });
});

describe("processUpload: size gate and type checks", () => {
  it("deletes an object above 10 MB before any GET", async () => {
    const record = upload({ declaredSize: MAX_UPLOAD_BYTES });
    seed(record, Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0xff));
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "too_large" });
    expect(store.opsFor("quarantine", record.quarantineKey)).toEqual(["head", "delete"]);
    expect(store.calls.some((call) => call.op === "get")).toBe(false);
    expect(store.keys("media")).toEqual([]);
    expect(stored(record.id)).toMatchObject({ status: "rejected", rejectReason: "too_large", size: MAX_UPLOAD_BYTES + 1 });
  });

  it("refuses an object larger than its declared size (byte quota dodge) without reading it", async () => {
    const record = upload({ declaredSize: 1_000 });
    const body = await noisyJpeg(400, 300);
    expect(body.byteLength).toBeGreaterThan(1_000);
    seed(record, body);
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "too_large" });
    expect(store.opsFor("quarantine", record.quarantineKey)).toEqual(["head", "delete"]);
  });

  it("rejects bytes that are not the declared type (bad_type)", async () => {
    const pngAsJpeg = upload({ declaredType: "image/png" });
    seed(pngAsJpeg, await plainJpeg());
    const html = upload();
    seed(html, Buffer.from("<html><script>alert(1)</script></html>".padEnd(400, " ")));
    for (const record of [pngAsJpeg, html]) {
      expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "bad_type" });
      expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    }
    expect(store.keys("media")).toEqual([]);
  });

  it("rejects a PNG bomb from its header (pixel cap) and never publishes anything", async () => {
    const record = upload({ declaredType: "image/png" });
    seed(record, pngBomb(20_000, 20_000));
    const classifier = clean();
    expect(await processUpload(record.id, { store, classifier })).toEqual({ status: "rejected", rejectReason: "too_large" });
    expect(classifier.calls).toBe(0);
    expect(store.keys("media")).toEqual([]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
  });

  it("rejects an undecodable image (decode_failed)", async () => {
    const record = upload();
    const jpeg = await noisyJpeg(400, 300);
    seed(record, jpeg.subarray(0, Math.floor(jpeg.byteLength * 0.6)));
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "decode_failed" });
  });

  it("expires an upload whose object never arrived, or whose listing is gone or read-only", async () => {
    const missing = upload();
    expect(await processUpload(missing.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "expired" });

    fake.listings.clear();
    const orphan = upload();
    seed(orphan, await plainJpeg());
    expect(await processUpload(orphan.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "expired" });
    // Nothing read: the listing is checked before the object.
    expect(store.opsFor("quarantine", orphan.quarantineKey)).toEqual(["delete"]);

    listing({ status: "sold" });
    const sold = upload();
    seed(sold, await plainJpeg());
    expect(await processUpload(sold.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "expired" });
  });
});

describe("processUpload: local checks", () => {
  it("refuses a photo at the nudity reject threshold before publishing anything, with a statement of reasons", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: new StubImageClassifier({ nsfw: 0.85, faces: 0 }), now: () => NOW })).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(store.keys("media")).toEqual([]);
    expect(store.calls.some((call) => call.op === "put")).toBe(false);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(stored(record.id)).toMatchObject({ status: "rejected", rejectReason: "nsfw", checks: { nsfw: 0.85, faces: 0 } });
    expect(attachReadyPhoto).not.toHaveBeenCalled();
    expect(recordModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: "upload", id: record.id }, affectedUid: "owner-1", action: "remove", automation: { detection: true, decision: true }, decidedBy: "system", notified: true }),
    );
  });

  it("keeps the review band and faces as checks for the listing screening", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: new StubImageClassifier({ nsfw: 0.7, faces: 2 }) })).toMatchObject({ status: "ready" });
    expect(stored(record.id).checks).toEqual({ nsfw: 0.7, faces: 2 });
    expect(recordModerationDecision).not.toHaveBeenCalled();
  });
});

describe("processUpload: photo limit", () => {
  it("rejects with quota when the draft is full and removes the variants it put", async () => {
    listing({ photos: Array.from({ length: 10 }, (_, i) => photo(`full${String(i).padStart(5, "0")}x`)) });
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "quota" });
    expect(store.keys("media")).toEqual([]);
    expect(store.opsFor("media", keyL(record.id))).toEqual(["put", "delete"]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });

  it("rejects with quota on a full live listing before putting anything", async () => {
    listing({ status: "paused", photos: Array.from({ length: 10 }, (_, i) => photo(`full${String(i).padStart(5, "0")}x`)) });
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "quota" });
    expect(store.calls.some((call) => call.op === "put")).toBe(false);
  });

  it("allows 20 photos on a Pro listing (pro branch kept)", async () => {
    listing({ sellerType: "pro", photos: Array.from({ length: 10 }, (_, i) => photo(`full${String(i).padStart(5, "0")}x`)) });
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready" });
    expect(vi.mocked(attachReadyPhoto).mock.calls[0]?.[2]).toMatchObject({ maxPhotos: 20 });
  });
});

describe("processUpload: idempotency and races", () => {
  it("answers finished, signed and missing uploads without touching storage", async () => {
    const ready = upload({ status: "ready", width: 800, height: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef", size: 1234, variants: ["l", "s"] });
    const rejected = upload({ status: "rejected", rejectReason: "nsfw" });
    const signed = upload({ status: "signed" });
    expect(await processUpload(ready.id, { store, classifier: clean() })).toEqual({ status: "ready", photo: { id: ready.id, w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" } });
    expect(await processUpload(rejected.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(await processUpload(signed.id, { store, classifier: clean() })).toEqual({ status: "processing" });
    expect(await processUpload("doesnotexist1", { store, classifier: clean() })).toBeNull();
    expect(store.calls).toEqual([]);
  });

  it("redoes the whole run after a failure (retry) and ends in the same state", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    fake.attachFailures.push(new Error("firestore unavailable"));
    await expect(processUpload(record.id, { store, classifier: clean() })).rejects.toThrow("firestore unavailable");
    // The original is still there for the retry; the variants are overwritten by it.
    expect(store.has("quarantine", record.quarantineKey)).toBe(true);
    expect(stored(record.id).status).toBe("processing");

    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready" });
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(store.opsFor("media", keyL(record.id))).toEqual(["put", "put"]);
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos.map((item) => item.id)).toEqual([record.id]);
    // A third call (repeated complete, retried job) changes nothing.
    const calls = store.calls.length;
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready" });
    expect(store.calls.length).toBe(calls);
  });

  it("undoes its work when the owner deleted the upload while it was processing", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    fake.readyWriteResult = { ok: false, upload: null };
    expect(await processUpload(record.id, { store, classifier: clean() })).toBeNull();
    expect(removePhoto).toHaveBeenCalledWith(LISTING_ID, record.id, expect.any(Date));
    expect(store.keys("media")).toEqual([]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });

  it("keeps the result of a concurrent run that finished first", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    fake.readyWriteResult = { ok: false, upload: { ...record, status: "ready", width: 64, height: 48, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" } };
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready", photo: { id: record.id } });
    expect(removePhoto).not.toHaveBeenCalled();
    expect(store.keys("media")).toEqual([keyL(record.id), keyS(record.id)]);
  });
});

describe("expireUpload", () => {
  it("rejects a stuck upload as expired, detaches it from the draft and deletes its objects", async () => {
    listing({ photos: [photo("upl99999abcdefgh")] });
    const record = upload({ id: "upl99999abcdefgh" });
    seed(record, await plainJpeg());
    store.seed("media", keyL(record.id), Buffer.from("x"), { contentType: "image/webp" });
    expect(await expireUpload(record.id, { store })).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(stored(record.id)).toMatchObject({ status: "rejected", rejectReason: "expired" });
    expect(removePhoto).toHaveBeenCalled();
    expect(store.keys("quarantine")).toEqual([]);
    expect(store.keys("media")).toEqual([]);
  });

  it("keeps the variants of a photo already shown on a live listing", async () => {
    listing({ status: "published", photos: [photo("upl88888abcdefgh"), photo("other0001x")] });
    const record = upload({ id: "upl88888abcdefgh" });
    store.seed("media", keyL(record.id), Buffer.from("x"), { contentType: "image/webp" });
    expect(await expireUpload(record.id, { store })).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(removePhoto).not.toHaveBeenCalled();
    expect(store.keys("media")).toEqual([keyL(record.id)]);
  });

  it("leaves finished uploads alone", async () => {
    const rejected = upload({ status: "rejected", rejectReason: "nsfw" });
    expect(await expireUpload(rejected.id, { store })).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(await expireUpload("doesnotexist1", { store })).toBeNull();
    expect(store.calls).toEqual([]);
  });
});
