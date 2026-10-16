import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// purge-quarantine (hourly :20): stale signed/processing uploads expired with their objects,
// rejected uploads' quarantine objects swept behind a cursor, unattached documents past purgeAt
// deleted with their objects, attached ones pushed 30 days on, legal holds and removed listings
// left alone. Repositories are mocked; a MemoryObjectStore records the storage calls.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/uploads/storage-gauge", () => ({ recordMediaBytes: vi.fn(async () => null) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/db/repositories/listings", () => ({ getListings: vi.fn(async () => []) }));
vi.mock("@/lib/db/repositories/uploads", () => ({
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
const { isDegraded } = await import("@/lib/quota");
const { recordMediaBytes } = await import("@/lib/uploads/storage-gauge");
const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { ATTACHED_RECHECK_MS, PURGE_QUARANTINE_BATCH, QUARANTINE_TTL_MS, REJECTED_SWEEP_DELAY_MS, REJECTED_SWEEP_LOOKBACK_MS, purgeQuarantine } = await import("@/worker/jobs/purge-quarantine");

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
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(recordMediaBytes).mockClear();
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

  it("leaves removed listings to retention-purge and keeps everything under a legal hold", async () => {
    const removed = upload("removed00001", { ...past, status: "ready", targetId: "removedd" });
    const held = upload("heldupload01", { ...past, status: "ready", targetId: "heldlist" });
    vi.mocked(repo.listPastPurge).mockResolvedValue([removed, held]);
    vi.mocked(getListings).mockResolvedValue([listing({ id: "removedd", status: "removed" }), listing({ id: "heldlist", legalHold: ["requisition-1"] })]);

    expect(await purgeQuarantine(NOW, { store })).toMatchObject({ purged: 0, extended: 0, skipped: 2 });
    expect(store.calls).toEqual([]);
  });

  it("deletes the uploads of a listing that no longer exists", async () => {
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
    expect(await purgeQuarantine(NOW, { store })).toEqual({ expired: 0, swept: 0, purged: 0, extended: 0, skipped: 0, failed: 0 });
    expect(repo.listExpiredQuarantine).not.toHaveBeenCalled();
  });
});
