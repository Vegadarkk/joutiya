import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { TransitionWrite } from "@/lib/db/repositories/retention";

// expire-listings (02:30 UTC, design D16): published and paused listings past expiresAt go
// `expired` through the lifecycle transition (re-checked in the transaction), the seller gets the
// listingExpired mail, every expiry is audited as a system action. Repositories are mocked; the
// transaction is a fake that runs the job's compute function on an in-memory listing.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/legal/config", () => ({ getLegalConfig: vi.fn(async () => ({ listingTtlDays: 60, listingPurgeMonths: 12, dsaContactEmail: "dsa@joutiya.ma" })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail/recipients", () => ({
  recipientCache: () => async (uid: string) => (uid === "gone" ? null : { email: `${uid}@example.com`, locale: uid === "arabic" ? "ar" : "fr", displayName: "Salma" }),
}));
vi.mock("@/lib/db/repositories/retention", () => ({
  EXPIRING_STATUSES: ["published", "paused"],
  listListingsToExpire: vi.fn(),
  applyListingTransition: vi.fn(),
}));

const retention = await import("@/lib/db/repositories/retention");
const { audit } = await import("@/lib/audit");
const { sendMail } = await import("@/lib/mail");
const { isDegraded } = await import("@/lib/quota");
const { EXPIRE_BATCH, EXPIRE_PAGES, expireListings } = await import("@/worker/jobs/expire-listings");

const NOW = new Date("2026-10-16T02:30:00Z");
const DAY = 86_400_000;

function listing(id: string, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id,
    ownerUid: "owner-1",
    status: "published",
    title: `Annonce ${id}`,
    version: 4,
    publishedAt: new Date(NOW.getTime() - 61 * DAY),
    expiresAt: new Date(NOW.getTime() - 3_600_000),
    purgeAt: new Date(NOW.getTime() + 300 * DAY),
    sortAt: new Date(NOW.getTime() - 61 * DAY),
    sortSource: "publish",
    legalHold: [],
    ...overrides,
  } as unknown as ListingRecord;
}

/** Firestore state the fake transaction reads (the listing as it is when the job reaches it). */
let current: Map<string, ListingRecord>;
let writes: { id: string; write: TransitionWrite }[];

beforeEach(() => {
  configured.value = true;
  current = new Map();
  writes = [];
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(audit).mockClear();
  vi.mocked(sendMail).mockReset().mockResolvedValue(undefined);
  vi.mocked(retention.listListingsToExpire).mockReset().mockResolvedValue({ listings: [], read: 0 });
  vi.mocked(retention.applyListingTransition)
    .mockReset()
    .mockImplementation(async (id, compute) => {
      const record = current.get(id);
      if (!record) return null;
      const write = compute(record);
      if (!write) return null;
      writes.push({ id, write });
      return { ...record, ...write.patch } as ListingRecord;
    });
});

function page(listings: ListingRecord[], read = listings.length) {
  const last = listings[listings.length - 1];
  return { listings, read, ...(last ? { next: { at: last.expiresAt!, id: last.id } } : {}) };
}

describe("expire-listings", () => {
  it("moves a published listing past expiry to expired: version + 1, purge in 12 months, index deletion, audit, mail", async () => {
    const record = listing("abcd2345");
    current.set(record.id, record);
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([record]));

    expect(await expireListings(NOW)).toEqual({ expired: 1, mailed: 1, skipped: 0, failed: 0 });
    expect(retention.listListingsToExpire).toHaveBeenCalledWith(NOW, EXPIRE_BATCH, undefined);
    expect(writes).toHaveLength(1);
    const { patch, search } = writes[0]!.write;
    expect(patch).toMatchObject({ status: "expired", version: 5, updatedAt: NOW, purgeAt: new Date("2027-10-16T02:30:00Z") });
    // Sold/paused/expired keep their dates (D16): the expiry does not touch expiresAt or sortAt.
    expect(patch).not.toHaveProperty("expiresAt");
    expect(patch).not.toHaveProperty("sortAt");
    expect(search).toBe("delete");
    expect(audit).toHaveBeenCalledWith({ actorUid: "system", actorRole: "system", action: "listing.expire", target: { type: "listing", id: "abcd2345" }, automated: true, at: NOW });
    expect(sendMail).toHaveBeenCalledWith({
      template: "listingExpired",
      locale: "fr",
      to: "owner-1@example.com",
      data: { displayName: "Salma", title: "Annonce abcd2345", purgeAt: "2027-10-16T02:30:00.000Z" },
      priority: "transactional",
      idempotencyKey: "listingExpired-abcd2345-5",
    });
  });

  it("expires a paused listing too (it could never resume after expiry) and keeps its pause reason", async () => {
    const record = listing("paused23", { status: "paused", pausedReason: "owner" });
    current.set(record.id, record);
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([record]));
    expect(await expireListings(NOW)).toMatchObject({ expired: 1 });
    expect(writes[0]!.write.patch.status).toBe("expired");
  });

  it("re-checks the listing in the transaction: renewed, sold or not yet expired since the query is left alone", async () => {
    const renewed = listing("renewed2");
    const sold = listing("soldsold");
    const later = listing("later234");
    current.set(renewed.id, { ...renewed, expiresAt: new Date(NOW.getTime() + 60 * DAY) });
    current.set(sold.id, { ...sold, status: "sold" });
    current.set(later.id, { ...later, expiresAt: new Date(NOW.getTime() + 1) });
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([renewed, sold, later, listing("deleted2")]));

    expect(await expireListings(NOW)).toEqual({ expired: 0, mailed: 0, skipped: 4, failed: 0 });
    expect(writes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("pages on with the cursor while pages are full, and stops at EXPIRE_PAGES", async () => {
    const full = Array.from({ length: EXPIRE_BATCH }, (_, index) => listing(`p${String(index).padStart(7, "0")}`));
    vi.mocked(retention.listListingsToExpire).mockResolvedValue(page(full));
    await expireListings(NOW);
    expect(retention.listListingsToExpire).toHaveBeenCalledTimes(EXPIRE_PAGES);
    const last = full[full.length - 1]!;
    expect(vi.mocked(retention.listListingsToExpire).mock.calls[1]).toEqual([NOW, EXPIRE_BATCH, { at: last.expiresAt, id: last.id }]);
  });

  it("stops after a short page, and an unreadable document still advances the cursor", async () => {
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce({ listings: [], read: 1, next: { at: NOW, id: "broken12" } });
    await expireListings(NOW);
    expect(retention.listListingsToExpire).toHaveBeenCalledTimes(1);
  });

  it("counts a failed transaction and goes on with the next listing", async () => {
    const a = listing("aaaa2345");
    const b = listing("bbbb2345");
    current.set(a.id, a);
    current.set(b.id, b);
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([a, b]));
    vi.mocked(retention.applyListingTransition).mockRejectedValueOnce(new Error("ABORTED"));
    expect(await expireListings(NOW)).toEqual({ expired: 1, mailed: 1, skipped: 0, failed: 1 });
  });

  it("a mail failure or a seller without address never undoes the expiry", async () => {
    const a = listing("aaaa2345");
    const b = listing("bbbb2345", { ownerUid: "gone" });
    current.set(a.id, a);
    current.set(b.id, b);
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([a, b]));
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("queue down"));
    expect(await expireListings(NOW)).toEqual({ expired: 2, mailed: 0, skipped: 0, failed: 0 });
  });

  it("mails in the seller's language", async () => {
    const record = listing("arab2345", { ownerUid: "arabic" });
    current.set(record.id, record);
    vi.mocked(retention.listListingsToExpire).mockResolvedValueOnce(page([record]));
    await expireListings(NOW);
    expect(vi.mocked(sendMail).mock.calls[0]?.[0]).toMatchObject({ locale: "ar", to: "arabic@example.com" });
  });

  it("does nothing without Firebase, and defers while the write quota is degraded", async () => {
    configured.value = false;
    expect(await expireListings(NOW)).toEqual({ expired: 0, mailed: 0, skipped: 0, failed: 0 });
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await expireListings(NOW)).toEqual({ expired: 0, mailed: 0, skipped: 0, failed: 0 });
    expect(retention.listListingsToExpire).not.toHaveBeenCalled();
  });
});
