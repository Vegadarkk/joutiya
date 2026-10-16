import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingPhoto } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// Pipeline of a listing photo (design §4 media/pipeline.ts, exit criteria §6) on generated
// fixtures: a MemoryObjectStore records every storage call (size gate before any GET), the
// StubImageClassifier drives the nudity paths, and in-memory fakes stand for the uploads and
// listings repositories (their transactions are covered by the API tests on the emulator).

const fake = vi.hoisted(() => ({
  uploads: new Map<string, unknown>(),
  listings: new Map<string, unknown>(),
  readyFailures: [] as Error[],
  readyOutcome: null as null | { ok: false; reason: "stale"; upload: unknown },
}));

type FakeListing = { id: string; status: string; photos: { id: string }[] };

function applyFakePatch(current: Record<string, unknown>, patch: Record<string, unknown>, now: Date): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, updatedAt: now };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
vi.mock("@/lib/db/repositories/moderation-decisions", () => ({ recordModerationDecision: vi.fn(async () => "decision-1") }));
vi.mock("@/lib/db/repositories/uploads", () => ({
  getUpload: vi.fn(async (id: string) => structuredClone(fake.uploads.get(id) ?? null)),
  transitionUpload: vi.fn(async (id: string, from: readonly string[], patch: Record<string, unknown>, now: Date) => {
    const current = fake.uploads.get(id) as Record<string, unknown> | undefined;
    if (!current || !from.includes(current.status as string)) return { ok: false, upload: current ? structuredClone(current) : null };
    const next = applyFakePatch(current, patch, now);
    fake.uploads.set(id, next);
    return { ok: true, upload: structuredClone(next) };
  }),
  // Same decisions as the repository's transaction, on the in-memory documents.
  markUploadReady: vi.fn(
    async (id: string, patch: Record<string, unknown>, attachment: { listingId: string; photo: { id: string }; maxPhotos: number; targetStatuses: readonly string[]; attachStatuses: readonly string[] }, now: Date) => {
      const failure = fake.readyFailures.shift();
      if (failure) throw failure;
      if (fake.readyOutcome) return fake.readyOutcome;
      const current = fake.uploads.get(id) as Record<string, unknown> | undefined;
      if (!current || current.status !== "processing") return { ok: false, reason: "stale", upload: current ? structuredClone(current) : null };
      const listing = fake.listings.get(attachment.listingId) as FakeListing | undefined;
      if (!listing || !attachment.targetStatuses.includes(listing.status)) return { ok: false, reason: "gone", upload: structuredClone(current) };
      const index = listing.photos.findIndex((item) => item.id === id);
      const attach = index >= 0 || attachment.attachStatuses.includes(listing.status);
      if (attach && index < 0 && listing.photos.length >= attachment.maxPhotos) return { ok: false, reason: "photo_limit", upload: structuredClone(current) };
      const next = applyFakePatch(current, { ...patch, status: "ready" }, now);
      fake.uploads.set(id, next);
      if (attach) {
        if (index >= 0) listing.photos[index] = attachment.photo;
        else listing.photos.push(attachment.photo);
      }
      return { ok: true, upload: structuredClone(next), attached: attach };
    },
  ),
}));
vi.mock("@/lib/db/repositories/listings", () => ({
  getListing: vi.fn(async (id: string) => structuredClone(fake.listings.get(id) ?? null)),
}));

const { expireUpload, processUpload } = await import("@/lib/media/pipeline");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { ClassifierUnavailableError, StubImageClassifier, UnavailableImageClassifier } = await import("@/lib/media/classify");
const { alert } = await import("@/lib/alert");
const { sharp } = await import("@/lib/media/sharp-setup");
const { markUploadReady, transitionUpload } = await import("@/lib/db/repositories/uploads");
const { recordModerationDecision } = await import("@/lib/db/repositories/moderation-decisions");
const { recordMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE } = await import("@/lib/media/urls");
const { MAX_UPLOAD_BYTES } = await import("@/lib/contracts/media");

const LISTING_ID = "abcdefgh";
const NOW = new Date("2026-10-16T10:00:00Z");
const clean = () => new StubImageClassifier({ nsfw: 0.02, faces: 0 });
/** A clean classifier that changes the listing's status mid-run (between the start and the final transaction). */
const listingBecomes = (status: string) => ({
  name: "fixture",
  classify: async () => {
    (fake.listings.get(LISTING_ID) as FakeListing).status = status;
    return { nsfw: 0.02, faces: 0 };
  },
});

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
  fake.readyFailures.length = 0;
  fake.readyOutcome = null;
  store = new MemoryObjectStore();
  vi.mocked(markUploadReady).mockClear();
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
    const attached = { id: record.id, w: 50, h: 100, blurhash: doc.blurhash, hash: doc.hash };
    expect(markUploadReady).toHaveBeenCalledWith(record.id, expect.objectContaining({ size: bytes, variants: ["l", "s"] }), expect.objectContaining({ listingId: LISTING_ID, photo: attached, maxPhotos: 10 }), NOW);
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos).toEqual([attached]);
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
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos.map((item) => item.id)).toEqual(["existing1"]);
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

describe("processUpload: checks unavailable (deployed without the models)", () => {
  it("never marks the photo ready: the run fails (retried, then expired) and publishes nothing", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    const classifier = new UnavailableImageClassifier("/app/models", "prod");
    await expect(processUpload(record.id, { store, classifier })).rejects.toBeInstanceOf(ClassifierUnavailableError);
    expect(stored(record.id)).toMatchObject({ status: "processing", checks: {} });
    expect(markUploadReady).not.toHaveBeenCalled();
    expect(store.keys("media")).toEqual([]);
    // The original stays for the retry; the last attempt expires the upload (expireUpload).
    expect(store.has("quarantine", record.quarantineKey)).toBe(true);
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos).toEqual([]);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1" }));
    expect(await expireUpload(record.id, { store, now: () => NOW })).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(store.keys("quarantine")).toEqual([]);
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

  it("reads at most the declared size when the object grew after the HEAD (second PUT)", async () => {
    const record = upload({ declaredSize: 2_000 });
    seed(record, await noisyJpeg(400, 300));
    vi.spyOn(store, "head").mockResolvedValueOnce({ size: 1_500, contentType: "image/jpeg" });
    const get = vi.spyOn(store, "get");
    expect(await processUpload(record.id, { store, classifier: clean() })).toEqual({ status: "rejected", rejectReason: "too_large" });
    expect(get).toHaveBeenCalledWith("quarantine", record.quarantineKey, { maxBytes: 2_000 });
    expect(stored(record.id)).toMatchObject({ status: "rejected", rejectReason: "too_large", size: 2_001 });
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
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
    expect(markUploadReady).not.toHaveBeenCalled();
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
    expect(vi.mocked(markUploadReady).mock.calls[0]?.[2]).toMatchObject({ maxPhotos: 20 });
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos).toHaveLength(11);
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
    fake.readyFailures.push(new Error("firestore unavailable"));
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
    fake.readyOutcome = { ok: false, reason: "stale", upload: null };
    expect(await processUpload(record.id, { store, classifier: clean() })).toBeNull();
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos).toEqual([]);
    expect(store.keys("media")).toEqual([]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });

  it("keeps the result of a concurrent run that finished first", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    fake.readyOutcome = { ok: false, reason: "stale", upload: { ...record, status: "ready", width: 64, height: 48, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" } };
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready", photo: { id: record.id } });
    expect(store.keys("media")).toEqual([keyL(record.id), keyS(record.id)]);
  });

  it("leaves the objects of a concurrent run that finished first when its own run is refused", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    listing({ photos: Array.from({ length: 10 }, (_, i) => photo(`full${String(i).padStart(5, "0")}x`)) });
    // This run is refused (draft full) after the other run marked the same upload ready.
    const ready = { ...record, status: "ready", width: 64, height: 48, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef", variants: ["l", "s"] };
    vi.mocked(markUploadReady).mockImplementationOnce(async (id) => {
      fake.uploads.set(id, ready);
      return { ok: false, reason: "photo_limit", upload: structuredClone(record) };
    });
    expect(await processUpload(record.id, { store, classifier: clean() })).toMatchObject({ status: "ready", photo: { id: record.id } });
    expect(store.keys("media")).toEqual([keyL(record.id), keyS(record.id)]);
  });

  it("does not attach to a draft published while it was processing (the owner's PATCH re-screens it)", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    listing({ photos: [photo("first0001x")] });
    expect(await processUpload(record.id, { store, classifier: listingBecomes("published") })).toMatchObject({ status: "ready" });
    expect((fake.listings.get(LISTING_ID) as ListingRecord).photos.map((item) => item.id)).toEqual(["first0001x"]);
    expect(stored(record.id).status).toBe("ready");
    expect(store.keys("media")).toEqual([keyL(record.id), keyS(record.id)]);
  });

  it("expires the upload and removes its variants when the listing was removed while it was processing", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    expect(await processUpload(record.id, { store, classifier: listingBecomes("removed") })).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(store.keys("media")).toEqual([]);
    expect(store.has("quarantine", record.quarantineKey)).toBe(false);
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });
});

describe("expireUpload", () => {
  it("rejects a stuck upload as expired, then deletes its objects", async () => {
    const record = upload();
    seed(record, await plainJpeg());
    store.seed("media", keyL(record.id), Buffer.from("x"), { contentType: "image/webp" });
    expect(await expireUpload(record.id, { store })).toEqual({ status: "rejected", rejectReason: "expired" });
    expect(stored(record.id)).toMatchObject({ status: "rejected", rejectReason: "expired" });
    expect(store.keys("quarantine")).toEqual([]);
    expect(store.keys("media")).toEqual([]);
  });

  it("keeps the result and the objects of a run that finished meanwhile", async () => {
    const record = upload();
    store.seed("media", keyL(record.id), Buffer.from("x"), { contentType: "image/webp" });
    const ready = { ...record, status: "ready", width: 64, height: 48, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", variants: ["l", "s"] };
    vi.mocked(transitionUpload).mockImplementationOnce(async () => ({ ok: false, upload: structuredClone(ready) as UploadRecord }));
    expect(await expireUpload(record.id, { store })).toMatchObject({ status: "ready", photo: { id: record.id } });
    expect(store.keys("media")).toEqual([keyL(record.id)]);
  });

  it("leaves finished uploads alone", async () => {
    const rejected = upload({ status: "rejected", rejectReason: "nsfw" });
    expect(await expireUpload(rejected.id, { store })).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(await expireUpload("doesnotexist1", { store })).toBeNull();
    expect(store.calls).toEqual([]);
  });
});
