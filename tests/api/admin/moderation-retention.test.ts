import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Nightly listing jobs against the Firestore emulator (design D16, architecture §5 "Fin de vie"):
// expire-listings (transaction, audit, mail), listing-expiry-reminders (cursor in
// system/listingReminders, at most once) and retention-purge (tombstone, uploads and objects,
// legal hold, contentOps / revealLogs). Real queries: their shapes must be valid Firestore queries.

// Search fast lane off: these tests read the searchOutbox entries it would drain (phase 4).
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { listingLifetime } from "@/config/pricing";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getListingDocument, readReminderCursor } from "@/lib/db/repositories/retention";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { getUpload } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { getLegalConfig } from "@/lib/legal/config";
import { purgeAtFor } from "@/lib/listings/lifecycle";
import { sendMail } from "@/lib/mail";
import { mediaObjectKey, retainedObjectKey } from "@/lib/media/urls";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { expireListings } from "@/worker/jobs/expire-listings";
import { reminderWindow, sendExpiryReminders } from "@/worker/jobs/listing-expiry-reminders";
import { purgeQuarantine } from "@/worker/jobs/purge-quarantine";
import { retentionPurge } from "@/worker/jobs/retention-purge";
import { capturedMails } from "../auth/helpers";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

const sendMailMock = vi.mocked(sendMail);
const HOUR_MS = 3_600_000;

let owner: Member;

beforeAll(async () => {
  resetServerEnv();
  owner = await member({ displayName: "Karim Vendeur" });
});

beforeEach(() => {
  resetRateLimiters();
  sendMailMock.mockClear();
});

/** A published listing with one ready photo (normal title: no hold). */
async function publishedListing(title: string): Promise<{ id: string; upload: string }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ title }) })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.body.status).toBe("published");
  return { id, upload };
}

/** Moves a listing in time (test seeding only: the jobs read what they find). */
async function setFields(id: string, fields: Record<string, unknown>): Promise<void> {
  const data = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value instanceof Date ? Timestamp.fromDate(value) : value]));
  await db().collection(COLLECTIONS.listings).doc(id).update(data);
}

async function auditActions(listingId: string): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", listingId).get();
  return snapshot.docs.map((doc) => String(doc.get("action")));
}

const mailsFor = (template: string, title: string) => capturedMails(sendMail).filter((mail) => mail.template === template && (mail.data as { title?: string }).title === title);

describe("expire-listings", () => {
  it("expires published and paused listings past expiresAt once, leaves the others", async () => {
    const now = new Date();
    const due = await publishedListing("Vélo de ville arrivé à échéance");
    const paused = await publishedListing("Vélo de ville en pause échu");
    const later = await publishedListing("Vélo de ville encore valide");
    await setFields(due.id, { expiresAt: new Date(now.getTime() - HOUR_MS) });
    await setFields(paused.id, { status: "paused", pausedReason: "owner", expiresAt: new Date(now.getTime() - DAY_MS) });
    const before = (await getListing(due.id))!;

    const result = await expireListings(now);
    expect(result.expired).toBeGreaterThanOrEqual(2);
    const expired = (await getListing(due.id))!;
    expect(expired).toMatchObject({ status: "expired", version: before.version + 1, expiresAt: before.expiresAt });
    const purgeAt = purgeAtFor(now, listingLifetime(await getLegalConfig()));
    expect(expired.purgeAt).toEqual(purgeAt);
    expect((await getListing(paused.id))?.status).toBe("expired");
    expect((await getListing(later.id))?.status).toBe("published");
    expect(await getSearchOutbox(due.id)).toMatchObject({ op: "delete", version: before.version + 1 });
    expect(await auditActions(due.id)).toContain("listing.expire");
    const mails = mailsFor("listingExpired", "Vélo de ville arrivé à échéance");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: owner.email, locale: "fr", idempotencyKey: `listingExpired-${due.id}-${before.version + 1}`, data: { displayName: "Karim Vendeur", purgeAt: purgeAt.toISOString() } });

    // A second run finds nothing more to do for these listings.
    sendMailMock.mockClear();
    await expireListings(new Date(now.getTime() + 1000));
    expect(mailsFor("listingExpired", "Vélo de ville arrivé à échéance")).toHaveLength(0);
    expect((await getListing(due.id))?.version).toBe(before.version + 1);
  });
});

describe("listing-expiry-reminders", () => {
  it("reminds listings expiring on the UTC day three days ahead, records the cursor, and never twice", async () => {
    await db().collection(COLLECTIONS.system).doc("listingReminders").delete();
    const now = new Date();
    const window = reminderWindow(now);
    const soon = await publishedListing("Vélo de ville bientôt expiré");
    const notYet = await publishedListing("Vélo de ville expire plus tard");
    await setFields(soon.id, { expiresAt: new Date(window.start.getTime() + 6 * HOUR_MS) });
    await setFields(notYet.id, { expiresAt: new Date(window.end.getTime() + HOUR_MS) });

    const first = await sendExpiryReminders(now);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const mails = mailsFor("listingExpiringSoon", "Vélo de ville bientôt expiré");
    const listing = (await getListing(soon.id))!;
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: owner.email, priority: "bulk", data: { url: `http://localhost:3000/fr/annonce/${listing.slugId}`, expiresAt: listing.expiresAt!.toISOString() } });
    expect(mailsFor("listingExpiringSoon", "Vélo de ville expire plus tard")).toHaveLength(0);
    expect(await readReminderCursor()).toEqual({ through: window.end, lastId: null });

    sendMailMock.mockClear();
    expect(await sendExpiryReminders(new Date(now.getTime() + HOUR_MS))).toEqual({ reminded: 0, skipped: 0, failed: 0 });
    expect(capturedMails(sendMail)).toHaveLength(0);
  });
});

describe("retention-purge", () => {
  it("tombstones a listing past purgeAt, deletes its upload documents and objects, spares a held listing", async () => {
    const now = new Date();
    const gone = await publishedListing("Vélo de ville à purger");
    const held = await publishedListing("Vélo de ville sous réquisition");
    await setFields(gone.id, { status: "expired", purgeAt: new Date(now.getTime() - DAY_MS) });
    await setFields(held.id, { status: "expired", purgeAt: new Date(now.getTime() - DAY_MS), legalHold: ["requisition-2026-01"] });
    const store = new MemoryObjectStore();
    for (const { id, upload } of [gone, held]) {
      const record = (await getUpload(upload))!;
      store.seed("quarantine", record.quarantineKey, Buffer.from("o"), { contentType: "image/jpeg" });
      for (const variant of ["l", "s"] as const) store.seed("media", mediaObjectKey(id, upload, variant), Buffer.from("v"), { contentType: "image/webp" });
    }
    const before = (await getListing(gone.id))!;

    const result = await retentionPurge(now, { store });
    expect(result.listings).toBeGreaterThanOrEqual(1);
    expect(result.held).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const tombstone = (await getListingDocument(gone.id)).data()!;
    // updatedAt: the next incremental backup carries the purge (restore writes the tombstone over older captures).
    expect(tombstone).toEqual({ status: "purged", categoryId: before.categoryId, purgedAt: Timestamp.fromDate(now), version: before.version + 1, updatedAt: Timestamp.fromDate(now) });
    expect(await getListing(gone.id)).toBeNull();
    expect(await getUpload(gone.upload)).toBeNull();
    expect(await getSearchOutbox(gone.id)).toMatchObject({ op: "delete", version: before.version + 1 });
    expect(await auditActions(gone.id)).toContain("listing.purge");
    expect(store.keys("media").some((key) => key.includes(gone.id))).toBe(false);
    expect(store.keys("quarantine").some((key) => key.includes(gone.upload))).toBe(false);

    expect((await getListing(held.id))?.status).toBe("expired");
    expect(await getUpload(held.upload)).not.toBeNull();
    expect(store.keys("media").filter((key) => key.includes(held.id))).toHaveLength(2);

    // Idempotent: the tombstone has no purgeAt, a second run leaves it alone.
    const again = await retentionPurge(new Date(now.getTime() + 1000), { store });
    expect(again.failed).toBe(0);
    expect((await getListingDocument(gone.id)).data()).toEqual(tombstone);
  });

  it("keeps a removed listing's photos until its own purgeAt, out of the public bucket: purge-quarantine moves them to the private one and their purgeAt there", async () => {
    const now = new Date();
    const removed = await publishedListing("Vélo de ville retiré par son vendeur");
    const listingPurgeAt = new Date(now.getTime() + 300 * DAY_MS);
    await setFields(removed.id, { status: "removed", purgeAt: listingPurgeAt });
    // The upload's own 7-day (or 30-day recheck) date passed long before the listing's purge.
    await db().collection(COLLECTIONS.uploads).doc(removed.upload).update({ purgeAt: Timestamp.fromDate(new Date(now.getTime() - HOUR_MS)) });
    const store = new MemoryObjectStore();
    for (const variant of ["l", "s"] as const) store.seed("media", mediaObjectKey(removed.id, removed.upload, variant), Buffer.from("v"), { contentType: "image/webp" });

    await retentionPurge(now, { store });
    expect(await getUpload(removed.upload)).not.toBeNull();
    // Changed seconds ago: the scan of removed listings has not reached it, the document purge moves it.
    await purgeQuarantine(now, { store });
    expect(await getUpload(removed.upload)).toMatchObject({ purgeAt: listingPurgeAt, bucket: "private", finalKey: `removed/listings/${removed.id}/${removed.upload}` });
    expect(store.keys("media").filter((key) => key.includes(removed.id))).toEqual([]);
    expect(store.keys("private")).toEqual([retainedObjectKey(removed.id, removed.upload, "l"), retainedObjectKey(removed.id, removed.upload, "s")]);
    expect((await getListing(removed.id))!.photos.map((photo) => photo.id)).toEqual([removed.upload]);

    // At the listing's purgeAt, retention-purge deletes them from the private bucket with the listing.
    await setFields(removed.id, { purgeAt: new Date(now.getTime() - DAY_MS) });
    expect((await retentionPurge(now, { store })).failed).toBe(0);
    expect(await getUpload(removed.upload)).toBeNull();
    expect(store.keys("private")).toEqual([]);
  });

  it("deletes contentOps and revealLogs past purgeAt, keeps the recent ones", async () => {
    const now = new Date();
    const tag = `retention-${now.getTime()}`;
    const refs = {
      oldOp: db().collection(COLLECTIONS.contentOps).doc(`${tag}-old`),
      newOp: db().collection(COLLECTIONS.contentOps).doc(`${tag}-new`),
      oldReveal: db().collection(COLLECTIONS.revealLogs).doc(`${tag}-old`),
      newReveal: db().collection(COLLECTIONS.revealLogs).doc(`${tag}-new`),
    };
    await refs.oldOp.set({ purgeAt: Timestamp.fromDate(new Date(now.getTime() - DAY_MS)) });
    await refs.newOp.set({ purgeAt: Timestamp.fromDate(new Date(now.getTime() + 300 * DAY_MS)) });
    await refs.oldReveal.set({ purgeAt: Timestamp.fromDate(new Date(now.getTime() - HOUR_MS)) });
    await refs.newReveal.set({ purgeAt: Timestamp.fromDate(new Date(now.getTime() + 80 * DAY_MS)) });

    const result = await retentionPurge(now, { store: new MemoryObjectStore() });
    expect(result.contentOps).toBeGreaterThanOrEqual(1);
    expect(result.revealLogs).toBeGreaterThanOrEqual(1);
    expect((await refs.oldOp.get()).exists).toBe(false);
    expect((await refs.oldReveal.get()).exists).toBe(false);
    expect((await refs.newOp.get()).exists).toBe(true);
    expect((await refs.newReveal.get()).exists).toBe(true);
  });
});
