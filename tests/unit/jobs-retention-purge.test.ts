import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// retention-purge (03:00 UTC): listings past purgeAt (expired, sold, removed, rejected, no legal
// hold) become tombstones and lose their media and upload documents (a removed listing keeps its
// photos until then, in the private bucket: no upload is deleted on its own purgeAt); contentOps and revealLogs past
// purgeAt are deleted in batches under a nightly budget. Repositories are mocked; a
// MemoryObjectStore records storage.

const stored = vi.hoisted(() => new Map<string, UploadRecord>());
vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => undefined) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/db/repositories/listings", () => ({ getListings: vi.fn(async () => []) }));
vi.mock("@/lib/db/repositories/uploads", () => ({
  UPLOADS_BY_TARGET_LIMIT: 100,
  listPastPurge: vi.fn(async () => []),
  listUploadsByTarget: vi.fn(async () => []),
  // Returns the document as stored, like the transaction: every fixture built by upload() below.
  deleteUploadDocument: vi.fn(async (id: string): Promise<UploadRecord | null> => stored.get(id) ?? null),
  updateUpload: vi.fn(async () => undefined),
}));
vi.mock("@/lib/db/repositories/retention", () => ({
  listListingsPastPurge: vi.fn(async () => ({ listings: [], read: 0 })),
  purgeListing: vi.fn(),
  deleteJournalPastPurge: vi.fn(async () => 0),
  oldestPastPurge: vi.fn(async () => null),
}));
vi.mock("@/lib/storage", async () => {
  const memory = await import("@/lib/storage/memory");
  class StorageNotConfiguredError extends Error {}
  return {
    MemoryObjectStore: memory.MemoryObjectStore,
    objectStore: vi.fn(() => {
      throw new StorageNotConfiguredError("not configured");
    }),
    isStorageNotConfigured: (error: unknown) => error instanceof StorageNotConfiguredError,
  };
});

const retention = await import("@/lib/db/repositories/retention");
const uploadsRepo = await import("@/lib/db/repositories/uploads");
const { getListings } = await import("@/lib/db/repositories/listings");
const { audit } = await import("@/lib/audit");
const { alert } = await import("@/lib/alert");
const { isDegraded } = await import("@/lib/quota");
const { recordMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { JOURNAL_BATCH, LISTING_PURGE_BATCH, PURGE_DELETE_BUDGET, isPurgeable, retentionPurge } = await import("@/worker/jobs/retention-purge");

const NOW = new Date("2026-10-16T03:00:00Z");
const DAY = 86_400_000;
let store: InstanceType<typeof MemoryObjectStore>;

function listing(id: string, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return { id, status: "expired", categoryId: "vehicules", photos: [], legalHold: [], version: 7, purgeAt: new Date(NOW.getTime() - DAY), ...overrides } as unknown as ListingRecord;
}

function upload(id: string, targetId: string, overrides: Partial<UploadRecord> = {}): UploadRecord {
  const record: UploadRecord = {
    id,
    ownerUid: "owner-1",
    purpose: "listing",
    targetId,
    declaredSize: 100_000,
    declaredType: "image/jpeg",
    status: "ready",
    size: 90_000,
    quarantineKey: `uploads/${id}`,
    bucket: "media",
    checks: {},
    purgeAt: new Date(NOW.getTime() - 3_600_000),
    createdAt: new Date(NOW.getTime() - 400 * DAY),
    updatedAt: NOW,
    ...overrides,
  };
  stored.set(id, record);
  return record;
}

function seed(listingId: string, photoId: string): void {
  store.seed("quarantine", `uploads/${photoId}`, Buffer.from("o"), { contentType: "image/jpeg" });
  for (const variant of ["l", "s"]) store.seed("media", `listings/${listingId}/${photoId}-${variant}.webp`, Buffer.from("v"), { contentType: "image/webp" });
}

/** Variants moved to the private bucket (purge-quarantine, removed listings). */
function seedPrivate(listingId: string, photoId: string): void {
  for (const variant of ["l", "s"]) store.seed("private", `removed/listings/${listingId}/${photoId}-${variant}.webp`, Buffer.from("v"), { contentType: "image/webp" });
}

function page(listings: ListingRecord[], read = listings.length) {
  const last = listings[listings.length - 1];
  return { listings, read, ...(last ? { next: { at: last.purgeAt!, id: last.id } } : {}) };
}

beforeEach(() => {
  stored.clear();
  configured.value = true;
  store = new MemoryObjectStore();
  for (const mocked of [retention, uploadsRepo]) for (const fn of Object.values(mocked)) if (vi.isMockFunction(fn)) fn.mockReset();
  vi.mocked(retention.listListingsPastPurge).mockResolvedValue({ listings: [], read: 0 });
  vi.mocked(retention.purgeListing).mockImplementation(async (id, purgeable) => (purgeable(listing(id)) ? { status: "purged", categoryId: "vehicules", purgedAt: NOW, version: 8, updatedAt: NOW } : null));
  vi.mocked(retention.deleteJournalPastPurge).mockResolvedValue(0);
  vi.mocked(retention.oldestPastPurge).mockResolvedValue(null);
  vi.mocked(uploadsRepo.listPastPurge).mockResolvedValue([]);
  vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([]);
  vi.mocked(getListings).mockReset().mockResolvedValue([]);
  vi.mocked(isDegraded).mockReset().mockResolvedValue(false);
  vi.mocked(audit).mockClear();
  vi.mocked(alert).mockClear();
  vi.mocked(recordMediaBytes).mockClear();
});

describe("isPurgeable", () => {
  it("only ended listings, past purgeAt, without a legal hold", () => {
    for (const status of ["expired", "sold", "removed", "rejected"] as const) expect(isPurgeable(listing("x", { status }), NOW)).toBe(true);
    for (const status of ["published", "paused", "pending_review", "draft", "purged"] as const) expect(isPurgeable(listing("x", { status }), NOW)).toBe(false);
    expect(isPurgeable(listing("x", { legalHold: ["report:r1"] }), NOW)).toBe(false);
    expect(isPurgeable(listing("x", { purgeAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(false);
    expect(isPurgeable(listing("x", { purgeAt: undefined }), NOW)).toBe(false);
    expect(isPurgeable(listing("x", { purgeAt: NOW }), NOW)).toBe(true);
  });
});

describe("retention-purge: listings", () => {
  it("tombstones a listing past purgeAt, then deletes its variants, quarantine objects and upload documents", async () => {
    const record = listing("abcd2345", { photos: [{ id: "photo00000000001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8" }, { id: "photo00000000002", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8" }] });
    seed(record.id, "photo00000000001");
    seed(record.id, "photo00000000002");
    seed(record.id, "rejected00000003");
    // Photo 2 lost its upload document; photo 3 was rejected and never attached.
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([upload("photo00000000001", record.id), upload("rejected00000003", record.id, { status: "rejected", size: 5_000 })]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));

    const result = await retentionPurge(NOW, { store });
    expect(result).toMatchObject({ listings: 1, uploads: 2, held: 0, skipped: 0, failed: 0, deferred: false });
    expect(retention.listListingsPastPurge).toHaveBeenCalledWith(NOW, LISTING_PURGE_BATCH, undefined);
    expect(retention.purgeListing).toHaveBeenCalledWith("abcd2345", expect.any(Function), NOW);
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("quarantine")).toEqual([]);
    expect(uploadsRepo.deleteUploadDocument).toHaveBeenCalledWith("photo00000000001");
    expect(uploadsRepo.deleteUploadDocument).toHaveBeenCalledWith("rejected00000003");
    expect(audit).toHaveBeenCalledWith({ actorUid: "system", actorRole: "system", action: "listing.purge", target: { type: "listing", id: "abcd2345" }, automated: true, at: NOW });
    // Only `ready` uploads occupy the media bucket gauge.
    expect(recordMediaBytes).toHaveBeenCalledWith(-90_000, NOW);
  });

  it("frees the bytes of a photo its owner deleted under a legal hold (variants kept), not those of a plain refusal", async () => {
    const record = listing("held2345", { photos: [] });
    seed(record.id, "heldphoto0000001");
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([
      upload("heldphoto0000001", record.id, { status: "rejected", rejectReason: "expired", heldObjects: true, size: 40_000 }),
      upload("rejected00000002", record.id, { status: "rejected", size: 5_000 }),
    ]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));

    expect(await retentionPurge(NOW, { store })).toMatchObject({ listings: 1, uploads: 2, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(recordMediaBytes).toHaveBeenCalledWith(-40_000, NOW);
  });

  it("frees nothing for, and does not count, an upload document another path deleted meanwhile (owner DELETE, purge-quarantine)", async () => {
    const record = listing("gone2345", { photos: [] });
    seed(record.id, "photogone0000001");
    seed(record.id, "photokept0000002");
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([upload("photogone0000001", record.id, { size: 40_000 }), upload("photokept0000002", record.id, { size: 25_000 })]);
    vi.mocked(uploadsRepo.deleteUploadDocument).mockResolvedValueOnce(null);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));

    expect(await retentionPurge(NOW, { store })).toMatchObject({ listings: 1, uploads: 1, failed: 0 });
    expect(store.keys("media")).toEqual([]);
    expect(recordMediaBytes).toHaveBeenCalledExactlyOnceWith(-25_000, NOW);
  });

  it("never touches another listing's objects", async () => {
    seed("other234", "photo00000000009");
    const record = listing("abcd2345");
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([upload("photo00000000001", record.id)]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));
    await retentionPurge(NOW, { store });
    expect(store.keys("media")).toEqual(["listings/other234/photo00000000009-l.webp", "listings/other234/photo00000000009-s.webp"]);
    expect(store.keys("quarantine")).toEqual(["uploads/photo00000000009"]);
    expect(store.calls.filter((call) => call.op === "delete").every((call) => call.key.includes("photo00000000001"))).toBe(true);
  });

  it("leaves held, live and unreadable listings, and those the transaction refuses (renewed meanwhile)", async () => {
    const held = listing("held2345", { legalHold: ["appeal:d1"] });
    const live = listing("live2345", { status: "published" });
    const renewed = listing("renew234");
    vi.mocked(retention.purgeListing).mockImplementation(async () => null);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce({ ...page([held, live, renewed]), read: 4 });

    const result = await retentionPurge(NOW, { store });
    expect(result).toMatchObject({ listings: 0, held: 1, skipped: 3, uploads: 0 });
    expect(retention.purgeListing).toHaveBeenCalledTimes(1);
    expect(uploadsRepo.listUploadsByTarget).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it("the transaction re-checks with the job's rule on the current document", async () => {
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([listing("abcd2345")]));
    await retentionPurge(NOW, { store });
    const purgeable = vi.mocked(retention.purgeListing).mock.calls[0]![1];
    expect(purgeable(listing("abcd2345", { status: "published" }))).toBe(false);
    expect(purgeable(listing("abcd2345", { legalHold: ["authority:a1"] }))).toBe(false);
    expect(purgeable(listing("abcd2345"))).toBe(true);
  });

  it("a storage failure after the tombstone hands the uploads to purge-quarantine (purgeAt = now)", async () => {
    const record = listing("abcd2345");
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([upload("photo00000000001", record.id), upload("photo00000000002", record.id)]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("R2 503"));

    const result = await retentionPurge(NOW, { store });
    expect(result).toMatchObject({ listings: 1, failed: 1, uploads: 0 });
    expect(uploadsRepo.updateUpload).toHaveBeenCalledWith("photo00000000001", { purgeAt: NOW }, NOW);
    expect(uploadsRepo.updateUpload).toHaveBeenCalledWith("photo00000000002", { purgeAt: NOW }, NOW);
    expect(uploadsRepo.deleteUploadDocument).not.toHaveBeenCalled();
  });

  it("pages on with the cursor while pages are full", async () => {
    const full = Array.from({ length: LISTING_PURGE_BATCH }, (_, index) => listing(`p${String(index).padStart(7, "0")}`, { status: "published" }));
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page([]));
    await retentionPurge(NOW, { store });
    const last = full[full.length - 1]!;
    expect(vi.mocked(retention.listListingsPastPurge).mock.calls[1]).toEqual([NOW, LISTING_PURGE_BATCH, { at: last.purgeAt, id: last.id }]);
  });
});

describe("retention-purge: removed listings keep their photos until their own purge", () => {
  it("never deletes an upload of a removed listing on the upload's purgeAt (no upload scan at all)", async () => {
    const removed = listing("removed2", { status: "removed", purgeAt: new Date(NOW.getTime() + 300 * DAY) });
    seed(removed.id, "upl0000000000001");
    vi.mocked(uploadsRepo.listPastPurge).mockResolvedValue([upload("upl0000000000001", removed.id)]);
    vi.mocked(getListings).mockResolvedValue([removed]);

    const result = await retentionPurge(NOW, { store });
    expect(result).toMatchObject({ uploads: 0, listings: 0, failed: 0 });
    expect(uploadsRepo.listPastPurge).not.toHaveBeenCalled();
    expect(uploadsRepo.deleteUploadDocument).not.toHaveBeenCalled();
    expect(store.keys("media")).toHaveLength(2);
  });

  it("deletes them with the listing once the listing's purgeAt passed (removal + 12 months), from the private bucket they moved to", async () => {
    const removed = listing("removed2", {
      status: "removed",
      photos: [
        { id: "upl0000000000001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8" },
        { id: "nodoc00000000002", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8" },
      ],
    });
    seedPrivate(removed.id, "upl0000000000001");
    // A move cut short before the document recorded it: the variants are private, the document still says media.
    seedPrivate(removed.id, "upl0000000000003");
    // A photo without its upload document.
    seedPrivate(removed.id, "nodoc00000000002");
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([
      upload("upl0000000000001", removed.id, { purgeAt: removed.purgeAt!, bucket: "private", finalKey: `removed/listings/${removed.id}/upl0000000000001` }),
      upload("upl0000000000003", removed.id, { purgeAt: removed.purgeAt! }),
    ]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([removed]));

    expect(await retentionPurge(NOW, { store })).toMatchObject({ listings: 1, uploads: 2, failed: 0 });
    expect(uploadsRepo.deleteUploadDocument).toHaveBeenCalledWith("upl0000000000001");
    expect(store.keys("media")).toEqual([]);
    expect(store.keys("private")).toEqual([]);
    // Both photos counted once in the gauge (bytes, not buckets).
    expect(recordMediaBytes).toHaveBeenCalledWith(-180_000, NOW);
  });

  it("an ended listing that was never removed only has variants in the media bucket", async () => {
    const record = listing("abcd2345", { status: "sold" });
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValue([upload("photo00000000001", record.id)]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));
    await retentionPurge(NOW, { store });
    expect(store.calls.filter((call) => call.bucket === "private")).toEqual([]);
    expect(store.calls.filter((call) => call.bucket === "media").map((call) => call.key)).toEqual(["listings/abcd2345/photo00000000001-l.webp", "listings/abcd2345/photo00000000001-m.webp", "listings/abcd2345/photo00000000001-s.webp"]);
  });

  it("reads the uploads of a purged listing page after page until a short page", async () => {
    const record = listing("abcd2345");
    const full = Array.from({ length: 100 }, (_, index) => upload(`full${String(index).padStart(12, "0")}`, record.id, { status: "rejected" }));
    vi.mocked(uploadsRepo.listUploadsByTarget).mockResolvedValueOnce(full).mockResolvedValueOnce([upload("last000000000001", record.id)]);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([record]));

    expect(await retentionPurge(NOW, { store })).toMatchObject({ listings: 1, uploads: 101, failed: 0 });
    expect(uploadsRepo.listUploadsByTarget).toHaveBeenCalledTimes(2);
  });
});

describe("retention-purge: journals and budget", () => {
  it("deletes contentOps and revealLogs past purgeAt in batches until a short batch", async () => {
    vi.mocked(retention.deleteJournalPastPurge).mockImplementation(async (collection, _now, limit) => {
      const calls = vi.mocked(retention.deleteJournalPastPurge).mock.calls.filter(([name]) => name === collection).length;
      if (collection === "contentOps") return calls === 1 ? limit : 12;
      return 3;
    });
    const result = await retentionPurge(NOW, { store });
    expect(result).toMatchObject({ contentOps: JOURNAL_BATCH + 12, revealLogs: 3, deferred: false });
    expect(retention.deleteJournalPastPurge).toHaveBeenCalledWith("contentOps", NOW, JOURNAL_BATCH);
    expect(retention.deleteJournalPastPurge).toHaveBeenCalledWith("revealLogs", NOW, JOURNAL_BATCH);
  });

  it("stops at the nightly budget and alerts when the backlog is older than 3 days", async () => {
    vi.mocked(retention.deleteJournalPastPurge).mockImplementation(async (_collection, _now, limit) => limit);
    vi.mocked(retention.oldestPastPurge).mockResolvedValue(new Date(NOW.getTime() - 4 * DAY));
    const result = await retentionPurge(NOW, { store });
    expect(result.contentOps).toBe(PURGE_DELETE_BUDGET);
    expect(result.revealLogs).toBe(0);
    expect(result.deferred).toBe(true);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Purge en retard : contentOps" }));
  });

  it("no alert for a fresh backlog", async () => {
    vi.mocked(retention.deleteJournalPastPurge).mockImplementation(async (_collection, _now, limit) => limit);
    vi.mocked(retention.oldestPastPurge).mockResolvedValue(new Date(NOW.getTime() - DAY));
    await retentionPurge(NOW, { store });
    expect(alert).not.toHaveBeenCalled();
  });

  it("defers every step while the delete quota is degraded", async () => {
    vi.mocked(isDegraded).mockResolvedValue(true);
    vi.mocked(retention.listListingsPastPurge).mockResolvedValueOnce(page([listing("abcd2345")]));
    const result = await retentionPurge(NOW, { store });
    expect(result.deferred).toBe(true);
    expect(retention.listListingsPastPurge).not.toHaveBeenCalled();
    expect(retention.deleteJournalPastPurge).not.toHaveBeenCalled();
  });

  it("without object storage, listings and uploads wait (no orphan objects) but journals are purged", async () => {
    vi.mocked(retention.deleteJournalPastPurge).mockResolvedValue(2);
    const result = await retentionPurge(NOW);
    expect(retention.listListingsPastPurge).not.toHaveBeenCalled();
    expect(uploadsRepo.listUploadsByTarget).not.toHaveBeenCalled();
    expect(result).toMatchObject({ contentOps: 2, revealLogs: 2 });
  });

  it("a failing step does not stop the others, and nothing runs without Firebase", async () => {
    vi.mocked(retention.listListingsPastPurge).mockRejectedValueOnce(new Error("FAILED_PRECONDITION"));
    vi.mocked(retention.deleteJournalPastPurge).mockResolvedValue(1);
    expect(await retentionPurge(NOW, { store })).toMatchObject({ failed: 1, contentOps: 1, revealLogs: 1 });
    configured.value = false;
    vi.mocked(retention.deleteJournalPastPurge).mockClear();
    expect(await retentionPurge(NOW, { store })).toMatchObject({ contentOps: 0, failed: 0 });
    expect(retention.deleteJournalPastPurge).not.toHaveBeenCalled();
  });
});
