import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The activeListings quota inside the commit transaction (service.ts commit, `maxActive`): the
// count before it (assertWithinQuota) is only a fast path, which two requests on different
// listings both pass at 19 of 20. Here the fast path is made to pass at the limit, so the count
// in the transaction must refuse (publish, resume, renewal, held edit); then two resumes run in
// parallel at 19 of 20.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/repositories/listings", { spy: true });

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { ACTIVE_STATUSES, countActive, countActiveTx, deleteListingDocument, getListing, listingRef, updateListing } from "@/lib/db/repositories/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

/** activeListings of an individual (config/pricing). */
const QUOTA = 20;
const SOFT_TITLE = "Réplique de vélo de course vintage";

async function readyDraft(owner: Member): Promise<string> {
  const id = (await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} })).body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  return id;
}

async function published(owner: Member): Promise<string> {
  const id = await readyDraft(owner);
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.body.status).toBe("published");
  return id;
}

const act = (handler: Handler, owner: Member, id: string, action: string) => api<ListingBody & ErrorBody>(handler, "POST", `/api/listings/${id}/${action}`, { member: owner });

/** Bare published documents of `owner`: enough for the counts (they do not parse as listings). */
async function fill(owner: Member, prefix: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-fill-${index}`);
  await Promise.all(ids.map((id) => listingRef(id).set({ ownerUid: owner.uid, status: "published" })));
  return ids;
}

async function activeCount(uid: string): Promise<number> {
  const result = await db().collection(COLLECTIONS.listings).where("ownerUid", "==", uid).where("status", "in", [...ACTIVE_STATUSES]).count().get();
  return result.data().count;
}

async function decisionsFor(id: string): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.moderationDecisions).where("target.id", "==", id).get();
  return snapshot.docs.map((doc) => doc.id);
}

describe("active quota in the commit transaction", () => {
  it("refuses publish, resume, renewal and a held edit at the limit even when the count before passed", { timeout: 60_000 }, async () => {
    const owner = await member();
    const toResume = await published(owner);
    const toRenew = await published(owner);
    const toHold = await published(owner);
    const toPublish = await readyDraft(owner);
    for (const id of [toResume, toHold]) expect((await act(pause, owner, id, "pause")).status).toBe(200);
    const now = Date.now();
    await updateListing(toRenew, { status: "expired", expiresAt: new Date(now - DAY_MS), purgeAt: new Date(now + 365 * DAY_MS) });
    const fillers = await fill(owner, toResume, QUOTA);
    try {
      const attempts: [string, () => Promise<{ status: number; body: ErrorBody }>][] = [
        ["publish", () => api<ErrorBody>(publish, "POST", `/api/listings/${toPublish}/publish`, { member: owner, body: { acceptRules: true } })],
        ["resume", () => act(resume, owner, toResume, "resume")],
        ["renew", () => act(renew, owner, toRenew, "renew")],
        // Flagged: held for review, the paused listing would take a slot again.
        ["held edit", () => api<ErrorBody>(patch, "PATCH", `/api/listings/${toHold}`, { member: owner, body: { title: SOFT_TITLE } })],
      ];
      for (const [name, attempt] of attempts) {
        vi.mocked(countActive).mockResolvedValueOnce(QUOTA - 1);
        vi.mocked(countActiveTx).mockClear();
        const result = await attempt();
        expect([result.status, result.body.error.code], name).toEqual([409, "listing_limit"]);
        expect(countActiveTx, name).toHaveBeenCalled();
      }
      expect((await getListing(toPublish))?.status).toBe("draft");
      expect((await getListing(toResume))?.status).toBe("paused");
      expect((await getListing(toRenew))?.status).toBe("expired");
      expect(await getListing(toHold)).toMatchObject({ status: "paused", title: readyPatch().title });
      // The transaction never wrote the hold decision.
      expect(await decisionsFor(toHold)).toEqual([]);
      expect(await activeCount(owner.uid)).toBe(QUOTA);
    } finally {
      await Promise.all(fillers.map((filler) => deleteListingDocument(filler)));
    }
    // Below the limit the same changes go through, counted in the transaction.
    vi.mocked(countActiveTx).mockClear();
    expect((await act(resume, owner, toResume, "resume")).status).toBe(200);
    expect(countActiveTx).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two parallel resumes through at 19 of 20", { timeout: 60_000 }, async () => {
    const owner = await member();
    const first = await published(owner);
    const second = await published(owner);
    for (const id of [first, second]) expect((await act(pause, owner, id, "pause")).status).toBe(200);
    const fillers = await fill(owner, first, QUOTA - 1);
    try {
      // Both pass the count before the transaction, however the two requests interleave.
      vi.mocked(countActive).mockResolvedValueOnce(QUOTA - 1).mockResolvedValueOnce(QUOTA - 1);
      const results = await Promise.all([act(resume, owner, first, "resume"), act(resume, owner, second, "resume")]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)?.body.error.code).toBe("listing_limit");
      expect(await activeCount(owner.uid)).toBe(QUOTA);
      expect([(await getListing(first))?.status, (await getListing(second))?.status].sort()).toEqual(["paused", "published"]);
    } finally {
      await Promise.all(fillers.map((filler) => deleteListingDocument(filler)));
    }
  });
});
