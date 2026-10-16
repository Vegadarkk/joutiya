import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// purge-quarantine (hourly :20): stale signed/processing uploads expired with their objects,
// rejected uploads' quarantine objects swept behind a cursor, removed listings' photos moved from
// the public media bucket to the private one (scan behind a cursor, backstop in the document
// purge), unattached documents past purgeAt deleted with their objects, attached ones pushed 30
// days on, legal holds (rechecked a day later) and removed listings (rechecked at the listing's
// purgeAt) left alone, never read again before then. Repositories are mocked; a MemoryObjectStore
// records the storage calls.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/db/repositories/listings", () => ({ getListings: vi.fn(async () => []) }));
vi.mock("@/lib/db/repositories/retention", () => ({ listListingsChangedBefore: vi.fn(async () => ({ listings: [], read: 0 })) }));
vi.mock("@/lib/db/repositories/uploads", () => ({
  UPLOADS_BY_TARGET_LIMIT: 100,
  listUploadsByTarget: vi.fn(async () => []),
  readRetainedScanCursor: vi.fn(async () => null),
  writeRetainedScanCursor: vi.fn(async () => undefined),
  listExpiredQuarantine: vi.fn(async () => []),
  listRejectedCreatedBetween: vi.fn(async () => []),
  readRejectedSweepCursor: vi.fn(async () => null),
  writeRejectedSweepCursor: vi.fn(async () => undefined),
  listPastPurge: vi.fn(async () => []),
  transitionUpload: vi.fn(async (id: string) => ({ ok: true, upload: { id } })),
  updateUpload: vi.fn(async () => undefined),
  deleteUploadDocument: vi.fn(async () => undefined),
}));

const repo = await import("@/lib/db/repositories/uploads");
const { getListings } = await import("@/lib/db/repositories/listings");
const { listListingsChangedBefore } = await import("@/lib/db/repositories/retention");
const { logger } = await import("@/lib/logging/logger");
const { isDegraded } = await import("@/lib/quota");
const { recordMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const {
  ATTACHED_RECHECK_MS,
  HOLD_RECHECK_MS,
  PURGE_QUARANTINE_BATCH,
  QUARANTINE_TTL_MS,
  REJECTED_SWEEP_DELAY_MS,
  REJECTED_SWEEP_LOOKBACK_MS,
  RETAINED_RECHECK_MS,
  RETAINED_SCAN_BATCH,
  RETAINED_SCAN_LAG_MS,
  RETAINED_SCAN_PAGES,
  attachedUntil,
  isPublicPhoto,
  purgeQuarantine,
  retainedUntil,
} = await import("@/worker/jobs/purge-quarantine");

const NOW = new Date("2026-10-16T12:20:00Z");
const LISTING = "abcdefgh";
let store: InstanceType<typeof MemoryObjectStore>;

function upload(id: string, overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    id,
    ownerUid: "owner-1",
    purpose: "listing",
    targetId: LISTING,
    declaredSize: 100_000,
    declaredType: "image/jpeg",
    status: "signed",
    quarantineKey: `uploads/${id}`,
    bucket: "media",
    checks: {},
    purgeAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: new Date(NOW.getTime() - 2 * QUARANTINE_TTL_MS),
    updatedAt: NOW,
    ...overrides,
  };
}

function listing(overrides: Partial<ListingRecord> = {}): ListingRecord {
  return { id: LISTING, status: "draft", photos: [], legalHold: [], ...overrides } as unknown as ListingRecord;
}

function seedObjects(record: UploadRecord): void {
  store.seed("quarantine", record.quarantineKey, Buffer.from("orig"), { contentType: "image/jpeg" });
  for (const variant of ["l", "s"]) store.seed("media", `listings/${record.targetId}/${record.id}-${variant}.webp`, Buffer.from("v"), { contentType: "image/webp" });
}

beforeEach(() => {
  configured.value = true;
  store = new MemoryObjectStore();
  for (const fn of Object.values(repo)) if (vi.isMockFunction(fn)) fn.mockClear();
  vi.mocked(repo.listExpiredQuarantine).mockResolvedValue([]);
  vi.mocked(repo.listRejectedCreatedBetween).mockResolvedValue([]);
  vi.mocked(repo.readRejectedSweepCursor).mockResolvedValue(null);
  vi.mocked(repo.listPastPurge).mockResolvedValue([]);
  vi.mocked(getListings).mockResolvedValue([]);
  vi.mocked(repo.listUploadsByTarget).mockResolvedValue([]);
  vi.mocked(repo.readRetainedScanCursor).mockResolvedValue(null);
  vi.mocked(repo.transitionUpload).mockImplementation(async (id: string) => ({ ok: true, upload: { id } as UploadRecord }));
  vi.mocked(repo.updateUpload).mockResolvedValue(undefined);
  vi.mocked(listListingsChangedBefore).mockReset().mockResolvedValue({ listings: [], read: 0 });
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(recordMediaBytes).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe("purge-quarantine: stale uploads", () => {
  it("marks uploads unprocessed after 24 h rejected (expired), then deletes their objects", async () => {
    const signed = upload("signed000001");
    const processing = upload("processing01", { status: "processing" });
    seedObjects(signed);
    seedObjects(processing);
    vi.mocked(repo.listExpiredQuarantine).mockResolvedValue([signed, processing]);

    const result = await purgeQuarantine(NOW, { store });
    expect(result).toMatchObject({ expired: 2, failed: 0 });
    expect(repo.listExpiredQuarantine).toHaveBeenCalledWith(new Date(NOW.getTime() - QUARANTINE_TTL_MS), PURGE_QUARANTINE_BATCH);
    expect(store.keys("quarantine")).toEqual([]);
    // A signed upload never had variants; a processing one may have.
    expect(store.opsFor("media", `listings/${LISTING}/signed000001-l.webp`)).toEqual([]);
    expect(store.keys("media")).toEqual([`listings/${LISTING}/signed000001-l.webp`, `listings/${LISTING}/signed000001-s.webp`]);
    expect(repo.transitionUpload).toHaveBeenCalledWith("signed000001", ["signed", "processing"], { status: "rejected", rejectReason: "expired" }, NOW);
    expect(repo.transitionUpload).toHaveBeenCalledWith("processing01", ["signed", "processing"], { status: "rejected", rejectReason: "expired" }, NOW);
  });

  it("leaves the objects of an upload that a run finished meanwhile", async () => {
    const finished = upload("finished0001", { status: "processing" });
    seedObjects(finished);
    vi.mocked(repo.listExpiredQuarantine).mockResolvedValue([finished]);
    vi.mocked(repo.transitionUpload).mockResolvedValueOnce({ ok: false, upload: { ...finished, status: "ready" } });
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ expired: 0, failed: 0 });
    expect(store.calls.filter((call) => call.op === "delete")).toEqual([]);
  });

  it("counts a failed deletion and goes on (the document purge retries it at purgeAt)", async () => {
    const a = upload("stale0000001");
    const b = upload("stale0000002");
    seedObjects(a);
    seedObjects(b);
    vi.mocked(repo.listExpiredQuarantine).mockResolvedValue([a, b]);
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("R2 500"));
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ expired: 2, failed: 1 });
    expect(store.has("quarantine", b.quarantineKey)).toBe(false);
  });
});

describe("purge-quarantine: rejected sweep", () => {
  it("deletes the quarantine objects of rejected uploads in creation order and moves the cursor", async () => {
    const a = upload("rejected0001", { status: "rejected", rejectReason: "nsfw", createdAt: new Date(NOW.getTime() - 3 * 3_600_000) });
    const b = upload("rejected0002", { status: "rejected", rejectReason: "bad_type", createdAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    seedObjects(a);
    seedObjects(b);
    vi.mocked(repo.listRejectedCreatedBetween).mockResolvedValue([a, b]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ swept: 2 });
    expect(repo.listRejectedCreatedBetween).toHaveBeenCalledWith(new Date(NOW.getTime() - REJECTED_SWEEP_LOOKBACK_MS), new Date(NOW.getTime() - REJECTED_SWEEP_DELAY_MS), PURGE_QUARANTINE_BATCH);
    expect(store.keys("quarantine")).toEqual([]);
    expect(repo.writeRejectedSweepCursor).toHaveBeenCalledWith(b.createdAt, NOW);
  });

  it("resumes from the stored cursor and stops it before a failed deletion", async () => {
    const cursor = new Date(NOW.getTime() - 5 * 3_600_000);
    vi.mocked(repo.readRejectedSweepCursor).mockResolvedValue(cursor);
    const a = upload("rejected0001", { status: "rejected", createdAt: new Date(NOW.getTime() - 4 * 3_600_000) });
    const b = upload("rejected0002", { status: "rejected", createdAt: new Date(NOW.getTime() - 3 * 3_600_000) });
    const c = upload("rejected0003", { status: "rejected", createdAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    vi.mocked(repo.listRejectedCreatedBetween).mockResolvedValue([a, b, c]);
    const original = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (bucket, key) => {
      if (key === b.quarantineKey) throw new Error("R2 503");
      return original(bucket, key);
    });

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ swept: 1, failed: 1 });
    expect(vi.mocked(repo.listRejectedCreatedBetween).mock.calls[0]?.[0]).toEqual(cursor);
    expect(repo.writeRejectedSweepCursor).toHaveBeenCalledWith(a.createdAt, NOW);
  });

  it("leaves the cursor alone when nothing was swept", async () => {
    await purgeQuarantine(NOW, { store });
    expect(repo.writeRejectedSweepCursor).not.toHaveBeenCalled();
  });
});

describe("purge-quarantine: documents past purgeAt", () => {
  const past = { purgeAt: new Date(NOW.getTime() - 1_000) };

  it("deletes unattached documents with their objects and gives their bytes back to the gauge", async () => {
    const ready = upload("readyunused1", { ...past, status: "ready", size: 50_000 });
    const rejected = upload("rejectedold1", { ...past, status: "rejected", rejectReason: "nsfw" });
    seedObjects(ready);
    seedObjects(rejected);
    vi.mocked(repo.listPastPurge).mockResolvedValue([ready, rejected]);
    vi.mocked(getListings).mockResolvedValue([listing({ photos: [] })]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 2, extended: 0, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("quarantine")).toEqual([]);
    expect(vi.mocked(repo.deleteUploadDocument).mock.calls.map(([id]) => id)).toEqual(["readyunused1", "rejectedold1"]);
    expect(recordMediaBytes).toHaveBeenCalledWith(-50_000, NOW);
  });

  it("moves the purgeAt of attached photos 30 days on and keeps their objects", async () => {
    const attached = upload("attached0001", { ...past, status: "ready", size: 50_000 });
    seedObjects(attached);
    vi.mocked(repo.listPastPurge).mockResolvedValue([attached]);
    vi.mocked(getListings).mockResolvedValue([listing({ status: "published", photos: [{ id: "attached0001", w: 1, h: 1, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }] })]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 0, extended: 1 });
    expect(repo.updateUpload).toHaveBeenCalledWith("attached0001", { purgeAt: new Date(NOW.getTime() + ATTACHED_RECHECK_MS) }, NOW);
    expect(store.keys("media")).toHaveLength(2);
    expect(repo.deleteUploadDocument).not.toHaveBeenCalled();
  });

  it("leaves removed listings to retention-purge until the listing's purgeAt, and holds for a day", async () => {
    const listingPurgeAt = new Date(NOW.getTime() + 300 * 86_400_000);
    const removed = upload("removed00001", { ...past, status: "ready", targetId: "removedd", bucket: "private" });
    const removedRejected = upload("removed00002", { ...past, status: "rejected", rejectReason: "nsfw", targetId: "removedd" });
    const held = upload("heldupload01", { ...past, status: "ready", targetId: "heldlist" });
    const heldRemoved = upload("heldupload02", { ...past, status: "ready", targetId: "heldremv", bucket: "private" });
    vi.mocked(repo.listPastPurge).mockResolvedValue([removed, removedRejected, held, heldRemoved]);
    vi.mocked(getListings).mockResolvedValue([
      listing({ id: "removedd", status: "removed", purgeAt: listingPurgeAt, photos: [{ id: "removed00001", w: 1, h: 1, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }] }),
      listing({ id: "heldlist", legalHold: ["requisition-1"] }),
      listing({ id: "heldremv", status: "removed", purgeAt: listingPurgeAt, legalHold: ["requisition-2"] }),
    ]);

    // Photos already in the private bucket (or never public: rejected): nothing to move.
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 0, extended: 0, skipped: 4, retained: 0, failed: 0 });
    expect(store.calls).toEqual([]);
    expect(repo.transitionUpload).not.toHaveBeenCalled();
    expect(repo.deleteUploadDocument).not.toHaveBeenCalled();
    // Each skipped upload gets a later purgeAt: the next hourly runs do not read it again.
    expect(vi.mocked(repo.updateUpload).mock.calls).toEqual([
      ["removed00001", { purgeAt: listingPurgeAt }, NOW],
      ["removed00002", { purgeAt: listingPurgeAt }, NOW],
      ["heldupload01", { purgeAt: new Date(NOW.getTime() + HOLD_RECHECK_MS) }, NOW],
      ["heldupload02", { purgeAt: new Date(NOW.getTime() + HOLD_RECHECK_MS) }, NOW],
    ]);
  });

  it("moves an attached photo's purgeAt to its listing's when that is later than 30 days (no rewrite every month)", async () => {
    const listingPurgeAt = new Date(NOW.getTime() + 400 * 86_400_000);
    const attached = upload("attached0001", { ...past, status: "ready", size: 50_000 });
    vi.mocked(repo.listPastPurge).mockResolvedValue([attached]);
    vi.mocked(getListings).mockResolvedValue([listing({ status: "published", purgeAt: listingPurgeAt, photos: [{ id: "attached0001", w: 1, h: 1, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }] })]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ extended: 1 });
    expect(repo.updateUpload).toHaveBeenCalledWith("attached0001", { purgeAt: listingPurgeAt }, NOW);
    expect(attachedUntil({ purgeAt: new Date(NOW.getTime() + 10 * 86_400_000) }, NOW)).toEqual(new Date(NOW.getTime() + ATTACHED_RECHECK_MS));
    expect(attachedUntil({ purgeAt: new Date(NOW.getTime() - 86_400_000) }, NOW)).toEqual(new Date(NOW.getTime() + ATTACHED_RECHECK_MS));
    expect(attachedUntil({ purgeAt: undefined }, NOW)).toEqual(new Date(NOW.getTime() + ATTACHED_RECHECK_MS));
  });

  it("rechecks a removed listing's uploads at least a day ahead (the listing's purge may be due tonight)", () => {
    expect(retainedUntil({ purgeAt: new Date(NOW.getTime() + 90 * 86_400_000) }, NOW)).toEqual(new Date(NOW.getTime() + 90 * 86_400_000));
    expect(retainedUntil({ purgeAt: new Date(NOW.getTime() - 1_000) }, NOW)).toEqual(new Date(NOW.getTime() + RETAINED_RECHECK_MS));
    expect(retainedUntil({ purgeAt: undefined }, NOW)).toEqual(new Date(NOW.getTime() + ATTACHED_RECHECK_MS));
  });

  it("counts a failed reschedule and goes on", async () => {
    vi.mocked(repo.listPastPurge).mockResolvedValue([upload("heldupload01", { ...past, status: "ready", targetId: "heldlist" }), upload("orphan000001", { ...past, status: "rejected" })]);
    vi.mocked(getListings).mockResolvedValue([listing({ id: "heldlist", legalHold: ["requisition-1"] })]);
    vi.mocked(repo.updateUpload).mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ skipped: 0, failed: 1, purged: 1 });
  });

  it("deletes the uploads of a listing that no longer exists (or is a tombstone: it does not read as a listing)", async () => {
    const orphan = upload("orphan000001", { ...past, status: "ready", size: 10 });
    vi.mocked(repo.listPastPurge).mockResolvedValue([orphan]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 1 });
    expect(repo.deleteUploadDocument).toHaveBeenCalledWith("orphan000001");
  });

  it("pages through full batches with a cursor and stops on a short page", async () => {
    const page = Array.from({ length: PURGE_QUARANTINE_BATCH }, (_, i) => upload(`page${String(i).padStart(8, "0")}`, { ...past, status: "rejected" }));
    vi.mocked(repo.listPastPurge).mockResolvedValueOnce(page).mockResolvedValueOnce([upload("lastone00001", { ...past, status: "rejected" })]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: PURGE_QUARANTINE_BATCH + 1 });
    expect(vi.mocked(repo.listPastPurge).mock.calls[1]?.[2]).toEqual({ purgeAt: past.purgeAt, id: page[page.length - 1]!.id });
    expect(repo.listPastPurge).toHaveBeenCalledTimes(2);
  });

  it("defers the document purge while the Firestore delete quota is degraded", async () => {
    vi.mocked(isDegraded).mockResolvedValue(true);
    vi.mocked(repo.listPastPurge).mockResolvedValue([upload("x00000000001", { ...past, status: "rejected" })]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 0 });
    expect(repo.listPastPurge).not.toHaveBeenCalled();
    expect(isDegraded).toHaveBeenCalledWith("firestore.deletes");
  });
});

describe("purge-quarantine: environment", () => {
  it("does nothing without Firebase", async () => {
    configured.value = false;
    expect(await purgeQuarantine(NOW, { store })).toEqual({ expired: 0, swept: 0, purged: 0, extended: 0, skipped: 0, retained: 0, failed: 0 });
    expect(repo.listExpiredQuarantine).not.toHaveBeenCalled();
  });
});

// ---- Photos of removed listings: media (public) -> private ------------------------------------

const BLUR = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
const mediaKey = (listingId: string, id: string, variant: string) => `listings/${listingId}/${id}-${variant}.webp`;
const privateKey = (listingId: string, id: string, variant: string) => `removed/listings/${listingId}/${id}-${variant}.webp`;

function seedVariants(listingId: string, id: string, bucket: "media" | "private" = "media", variants: readonly string[] = ["l", "s"]): void {
  for (const variant of variants) {
    const key = bucket === "media" ? mediaKey(listingId, id, variant) : privateKey(listingId, id, variant);
    store.seed(bucket, key, Buffer.from(`${id}-${variant}-bytes`), { contentType: "image/webp" });
  }
}

function removedListing(id: string, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return listing({ id, status: "removed", updatedAt: new Date(NOW.getTime() - 3_600_000), purgeAt: new Date(NOW.getTime() + 365 * 86_400_000), ...overrides } as Partial<ListingRecord>);
}

function scanPage(listings: ListingRecord[], read = listings.length) {
  const last = listings[listings.length - 1];
  return { listings, read, ...(last ? { next: { at: last.updatedAt, id: last.id } } : {}) };
}

describe("purge-quarantine: photos of removed listings leave the public bucket", () => {
  it("moves every public ready photo of a newly removed listing to the private bucket, records it, then moves the cursor", async () => {
    const removed = removedListing("removedd", { photos: [{ id: "photo0000001", w: 1, h: 1, blurhash: BLUR }] });
    const attached = upload("photo0000001", { status: "ready", targetId: removed.id, size: 30 });
    const unattached = upload("photo0000002", { status: "ready", targetId: removed.id, size: 20 });
    seedVariants(removed.id, attached.id);
    seedVariants(removed.id, unattached.id);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([attached, unattached]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 2, failed: 0 });
    expect(listListingsChangedBefore).toHaveBeenCalledWith(["removed"], new Date(NOW.getTime() - RETAINED_SCAN_LAG_MS), RETAINED_SCAN_BATCH, undefined);
    expect(repo.listUploadsByTarget).toHaveBeenCalledWith(removed.id, ["ready", "rejected"]);
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("private")).toEqual([privateKey(removed.id, "photo0000001", "l"), privateKey(removed.id, "photo0000001", "s"), privateKey(removed.id, "photo0000002", "l"), privateKey(removed.id, "photo0000002", "s")]);
    // Copy, check, and only then delete the public copy.
    expect(store.opsFor("media", mediaKey(removed.id, "photo0000001", "l"))).toEqual(["get", "delete"]);
    expect(store.opsFor("private", privateKey(removed.id, "photo0000001", "l"))).toEqual(["put", "head"]);
    expect(store.calls.findIndex((call) => call.op === "delete" && call.key === mediaKey(removed.id, "photo0000001", "l"))).toBeGreaterThan(
      store.calls.findIndex((call) => call.op === "head" && call.key === privateKey(removed.id, "photo0000001", "l")),
    );
    expect((await store.get("private", privateKey(removed.id, "photo0000001", "l")))?.toString()).toBe("photo0000001-l-bytes");
    expect(repo.transitionUpload).toHaveBeenCalledWith("photo0000001", ["ready", "rejected"], { bucket: "private", finalKey: `removed/listings/${removed.id}/photo0000001` }, NOW);
    expect(repo.transitionUpload).toHaveBeenCalledWith("photo0000002", ["ready", "rejected"], { bucket: "private", finalKey: `removed/listings/${removed.id}/photo0000002` }, NOW);
    expect(repo.writeRetainedScanCursor).toHaveBeenCalledWith({ at: removed.updatedAt, id: removed.id }, NOW);
    // Bytes only change bucket: the storage gauge does not move.
    expect(recordMediaBytes).not.toHaveBeenCalled();
  });

  it("leaves photos already private, and uploads without variants, alone (no storage call)", async () => {
    const removed = removedListing("removedd");
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([upload("photo0000001", { status: "ready", targetId: removed.id, bucket: "private" })]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 0, failed: 0 });
    expect(store.calls).toEqual([]);
    expect(repo.transitionUpload).not.toHaveBeenCalled();
    expect(isPublicPhoto({ purpose: "listing", status: "rejected", bucket: "media" })).toBe(false);
    expect(isPublicPhoto({ purpose: "listing", status: "rejected", bucket: "media", variants: [] })).toBe(false);
    expect(isPublicPhoto({ purpose: "listing", status: "processing", bucket: "media", variants: ["l", "s"] })).toBe(false);
    expect(isPublicPhoto({ purpose: "listing", status: "ready", bucket: "media" })).toBe(true);
    expect(isPublicPhoto({ purpose: "listing", status: "ready", bucket: "private" })).toBe(false);
    expect(isPublicPhoto({ purpose: "kyb", status: "ready", bucket: "media" })).toBe(false);
  });

  it("also moves a photo its owner deleted under a legal hold (rejected once ready: variants kept as evidence)", async () => {
    const removed = removedListing("removedd");
    const heldDeletion = upload("photo0000001", { status: "rejected", rejectReason: "expired", variants: ["l", "s"], targetId: removed.id, size: 40 });
    const refused = upload("photo0000002", { status: "rejected", rejectReason: "nsfw", targetId: removed.id });
    seedVariants(removed.id, heldDeletion.id);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([heldDeletion, refused]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 1, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("private")).toEqual([privateKey(removed.id, heldDeletion.id, "l"), privateKey(removed.id, heldDeletion.id, "s")]);
    expect(repo.transitionUpload).toHaveBeenCalledTimes(1);
    expect(repo.transitionUpload).toHaveBeenCalledWith(heldDeletion.id, ["ready", "rejected"], { bucket: "private", finalKey: `removed/listings/${removed.id}/${heldDeletion.id}` }, NOW);
    expect(store.calls.some((call) => call.key.includes(refused.id))).toBe(false);
  });

  it("finishes a move a crash cut short: a variant already moved is not copied again, the other one is", async () => {
    const removed = removedListing("removedd");
    const photo = upload("photo0000001", { status: "ready", targetId: removed.id });
    // The previous run copied and checked `l`, deleted its public copy, then stopped.
    seedVariants(removed.id, photo.id, "private", ["l"]);
    seedVariants(removed.id, photo.id, "media", ["s"]);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([photo]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 1, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("private")).toEqual([privateKey(removed.id, photo.id, "l"), privateKey(removed.id, photo.id, "s")]);
    expect(store.opsFor("private", privateKey(removed.id, photo.id, "l"))).toEqual(["head"]);
    expect(repo.transitionUpload).toHaveBeenCalledTimes(1);
  });

  it("records the move even when a variant is in neither bucket (nothing left to serve publicly), with a warning", async () => {
    const removed = removedListing("removedd");
    const photo = upload("photo0000001", { status: "ready", targetId: removed.id });
    seedVariants(removed.id, photo.id, "media", ["l"]);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([photo]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 1, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith({ uploadId: photo.id, missing: 1 }, expect.stringContaining("neither bucket"));
  });

  it("keeps the public copy when the private copy does not check out, and hands the upload to the document purge", async () => {
    const removed = removedListing("removedd");
    const photo = upload("photo0000001", { status: "ready", targetId: removed.id, purgeAt: new Date(NOW.getTime() + 30 * 86_400_000) });
    seedVariants(removed.id, photo.id);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([photo]);
    vi.spyOn(store, "head").mockResolvedValueOnce({ size: 1, contentType: "image/webp" });

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 0, failed: 1 });
    expect(store.has("media", mediaKey(removed.id, photo.id, "l"))).toBe(true);
    expect(store.has("media", mediaKey(removed.id, photo.id, "s"))).toBe(true);
    expect(repo.transitionUpload).not.toHaveBeenCalled();
    // purgeAt = now: the next hourly document purge retries the move.
    expect(repo.updateUpload).toHaveBeenCalledWith(photo.id, { purgeAt: NOW }, NOW);
    expect(repo.writeRetainedScanCursor).toHaveBeenCalledWith({ at: removed.updatedAt, id: removed.id }, NOW);
  });

  it("stops the cursor before a listing whose failed upload cannot even be handed over, and goes on next run from there", async () => {
    const first = removedListing("removed1", { updatedAt: new Date(NOW.getTime() - 3 * 3_600_000) });
    const second = removedListing("removed2", { updatedAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    const third = removedListing("removed3", { updatedAt: new Date(NOW.getTime() - 3_600_000) });
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([first, second, third]));
    vi.mocked(repo.listUploadsByTarget).mockImplementation(async (targetId: string) => [upload(`photo${targetId}`, { status: "ready", targetId, purgeAt: new Date(NOW.getTime() + 86_400_000) })]);
    seedVariants(first.id, `photo${first.id}`);
    seedVariants(third.id, `photo${third.id}`);
    vi.spyOn(store, "get").mockImplementation(async (bucket, key) => {
      if (key.includes(second.id)) throw new Error("R2 503");
      return MemoryObjectStore.prototype.get.call(store, bucket, key);
    });
    vi.mocked(repo.updateUpload).mockRejectedValueOnce(new Error("UNAVAILABLE"));

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 1, failed: 2 });
    expect(repo.writeRetainedScanCursor).toHaveBeenCalledWith({ at: first.updatedAt, id: first.id }, NOW);
    expect(store.keys("media")).toEqual([mediaKey(third.id, `photo${third.id}`, "l"), mediaKey(third.id, `photo${third.id}`, "s")]);
  });

  it("resumes from the stored cursor, pages on while pages are full, and stores the last position read", async () => {
    const cursor = { at: new Date(NOW.getTime() - 86_400_000), id: "previous" };
    vi.mocked(repo.readRetainedScanCursor).mockResolvedValue(cursor);
    const full = Array.from({ length: RETAINED_SCAN_BATCH }, (_, index) => removedListing(`r${String(index).padStart(7, "0")}`));
    const tail = { listings: [], read: 1, next: { at: new Date(NOW.getTime() - 3_600_000), id: "unreadable" } };
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage(full)).mockResolvedValueOnce(tail);

    await purgeQuarantine(NOW, { store });
    const calls = vi.mocked(listListingsChangedBefore).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[3]).toEqual(cursor);
    expect(calls[1]?.[3]).toEqual({ at: full[full.length - 1]!.updatedAt, id: full[full.length - 1]!.id });
    // Past a document that does not parse as well: it is never read again.
    expect(repo.writeRetainedScanCursor).toHaveBeenCalledWith(tail.next, NOW);
  });

  it("reads at most RETAINED_SCAN_PAGES pages a run", async () => {
    vi.mocked(listListingsChangedBefore).mockImplementation(async () => scanPage(Array.from({ length: RETAINED_SCAN_BATCH }, (_, index) => removedListing(`r${String(index).padStart(7, "0")}`))));
    await purgeQuarantine(NOW, { store });
    expect(listListingsChangedBefore).toHaveBeenCalledTimes(RETAINED_SCAN_PAGES);
  });

  it("leaves the cursor alone when no removed listing changed", async () => {
    await purgeQuarantine(NOW, { store });
    expect(listListingsChangedBefore).toHaveBeenCalledTimes(1);
    expect(repo.writeRetainedScanCursor).not.toHaveBeenCalled();
  });

  it("moves under a legal hold too (nothing is deleted before its private copy is checked)", async () => {
    const held = removedListing("heldremv", { legalHold: ["requisition-1"] });
    const photo = upload("photo0000001", { status: "ready", targetId: held.id });
    seedVariants(held.id, photo.id);
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([held]));
    vi.mocked(repo.listUploadsByTarget).mockResolvedValue([photo]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 1 });
    expect(store.keys("private")).toHaveLength(2);
    expect(store.keys("media")).toEqual([]);
  });

  it("moves an attached photo whose upload document is missing (its keys are derivable)", async () => {
    const removed = removedListing("removedd", { photos: [{ id: "lostdoc00001", w: 1, h: 1, blurhash: BLUR }] });
    seedVariants(removed.id, "lostdoc00001");
    vi.mocked(listListingsChangedBefore).mockResolvedValueOnce(scanPage([removed]));
    await purgeQuarantine(NOW, { store });
    expect(store.keys("private")).toEqual([privateKey(removed.id, "lostdoc00001", "l"), privateKey(removed.id, "lostdoc00001", "s")]);
    expect(store.keys("media")).toEqual([]);
  });

  it("defers the scan while the Firestore write quota is degraded; a failing scan query does not stop the document purge", async () => {
    vi.mocked(isDegraded).mockImplementation(async (id) => id === "firestore.writes");
    vi.mocked(repo.listPastPurge).mockResolvedValue([upload("x00000000001", { purgeAt: new Date(NOW.getTime() - 1_000), status: "rejected" })]);
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 1 });
    expect(listListingsChangedBefore).not.toHaveBeenCalled();

    vi.mocked(isDegraded).mockResolvedValue(false);
    vi.mocked(listListingsChangedBefore).mockRejectedValueOnce(new Error("FAILED_PRECONDITION"));
    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 1, failed: 1 });
  });
});

describe("purge-quarantine: document purge and removed listings' photos", () => {
  const past = { purgeAt: new Date(NOW.getTime() - 1_000) };

  it("moves a public photo the scan missed before moving its purgeAt to the listing's (also under a hold)", async () => {
    const listingPurgeAt = new Date(NOW.getTime() + 300 * 86_400_000);
    const removed = removedListing("removedd", { purgeAt: listingPurgeAt });
    const held = removedListing("heldremv", { purgeAt: listingPurgeAt, legalHold: ["appeal-1"] });
    const a = upload("photo0000001", { ...past, status: "ready", targetId: removed.id });
    const b = upload("photo0000002", { ...past, status: "ready", targetId: held.id });
    seedVariants(removed.id, a.id);
    seedVariants(held.id, b.id);
    vi.mocked(repo.listPastPurge).mockResolvedValue([a, b]);
    vi.mocked(getListings).mockResolvedValue([removed, held]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 2, skipped: 2, purged: 0, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("private")).toHaveLength(4);
    expect(vi.mocked(repo.updateUpload).mock.calls).toEqual([
      [a.id, { purgeAt: listingPurgeAt }, NOW],
      [b.id, { purgeAt: new Date(NOW.getTime() + HOLD_RECHECK_MS) }, NOW],
    ]);
  });

  it("leaves purgeAt in the past when the move fails: the next hourly run retries it", async () => {
    const removed = removedListing("removedd");
    const photo = upload("photo0000001", { ...past, status: "ready", targetId: removed.id });
    seedVariants(removed.id, photo.id);
    vi.mocked(repo.listPastPurge).mockResolvedValue([photo]);
    vi.mocked(getListings).mockResolvedValue([removed]);
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("R2 500"));

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ retained: 0, skipped: 0, failed: 1 });
    expect(repo.updateUpload).not.toHaveBeenCalled();
    expect(store.keys("media")).toHaveLength(2);
  });

  it("deletes an orphan's variants from both buckets (a purged removed listing's may be private)", async () => {
    const moved = upload("orphan000001", { ...past, status: "ready", size: 10, bucket: "private" });
    const media = upload("orphan000002", { ...past, status: "ready", size: 10 });
    seedVariants(LISTING, moved.id, "private");
    seedVariants(LISTING, media.id, "private");
    vi.mocked(repo.listPastPurge).mockResolvedValue([moved, media]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 2 });
    expect(store.keys("private")).toEqual([]);
    expect(recordMediaBytes).toHaveBeenCalledWith(-20, NOW);
  });

  it("an unattached upload of a live listing only has variants in the media bucket", async () => {
    const unused = upload("readyunused1", { ...past, status: "ready", size: 5 });
    vi.mocked(repo.listPastPurge).mockResolvedValue([unused]);
    vi.mocked(getListings).mockResolvedValue([listing({ status: "published" })]);
    await purgeQuarantine(NOW, { store });
    expect(store.calls.filter((call) => call.bucket === "private")).toEqual([]);
  });
});
