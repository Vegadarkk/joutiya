import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Owner actions on a published listing (lifecycle §5, D16): pause / resume / sold / renew / remove
// through the API, the forbidden transitions (409 conflict), the search outbox and audit effects;
// edits after publication (paused, expired: screened, held, revalidated), the screened renewal of
// an expired listing (not held again when a moderator approved the unchanged content), saves that
// change nothing (no write, no screening) and the active quota on resume and renewal.

// Search fast lane off: these tests read the searchOutbox entries it would drain (phase 4).
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/listings/revalidate", { spy: true });

import { POST as create } from "@/app/api/listings/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import { POST as sold } from "@/app/api/listings/[id]/sold/route";
import type { CreateListingResponse, FieldIssue, OwnerListingsResponse } from "@/lib/contracts/listings";
import { listContentOps, listingContentRef } from "@/lib/db/repositories/content-ops";
import { deleteListingDocument, getListing, listingRef, updateListing } from "@/lib/db/repositories/listings";
import { getModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { getUpload } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { sendMail } from "@/lib/mail";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { lastMail } from "../auth/helpers";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "./helpers";

const revalidateMock = vi.mocked(revalidateListingPaths);
const sendMailMock = vi.mocked(sendMail);

beforeAll(() => resetServerEnv());
beforeEach(() => {
  resetRateLimiters();
  revalidateMock.mockClear();
  sendMailMock.mockClear();
});

type Invalid = ErrorBody & { error: { details: FieldIssue[] } };
const codesOf = (issues: FieldIssue[]) => issues.map((issue) => `${issue.path}:${issue.code}`);
const SOFT_TITLE = "Réplique de vélo de course vintage";
const PHONE_TEXT = "Vélo de ville 28 pouces, 6 vitesses, révisé récemment. Appelez-moi au 06 12 34 56 78 pour le voir.";

/** The expiry job has run: expired a day ago, purge in a year (the job's own patch). */
async function expire(id: string): Promise<void> {
  const now = Date.now();
  await updateListing(id, { status: "expired", expiresAt: new Date(now - DAY_MS), purgeAt: new Date(now + 365 * DAY_MS) });
}

async function decisionsFor(id: string): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.moderationDecisions).where("target.id", "==", id).get();
  return snapshot.docs.map((doc) => doc.id);
}

async function published(owner: Member, title = "Vélo de ville Peugeot en bon état"): Promise<{ id: string; upload: string }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ title }) })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.status).toBe(200);
  expect(result.body.status).toBe("published");
  return { id, upload };
}

const act = (handler: Handler, owner: Member, id: string, action: string) => api<ListingBody & ErrorBody>(handler, "POST", `/api/listings/${id}/${action}`, { member: owner });

describe("pause / resume / sold", () => {
  it("pauses (search delete), resumes (search upsert) and marks sold, keeping the dates", async () => {
    const owner = await member();
    const { id } = await published(owner);
    const before = (await getListing(id))!;

    const paused = await act(pause, owner, id, "pause");
    expect(paused.status).toBe(200);
    expect(paused.body.listing).toMatchObject({ status: "paused", pausedReason: "owner", publishedAt: before.publishedAt!.toISOString(), expiresAt: before.expiresAt!.toISOString(), version: before.version + 1 });
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete", version: before.version + 1 });
    // A paused listing frees its slot: it sits in the "active" tab still (owner can resume it).
    const active = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=active", { member: owner });
    expect(active.body.listings.map((listing) => listing.status)).toEqual(["paused"]);

    const resumed = await act(resume, owner, id, "resume");
    expect(resumed.status).toBe(200);
    expect(resumed.body.listing).toMatchObject({ status: "published", pausedReason: null, publishedAt: before.publishedAt!.toISOString(), expiresAt: before.expiresAt!.toISOString() });
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: before.version + 2 });

    const done = await act(sold, owner, id, "sold");
    expect(done.status).toBe(200);
    expect(done.body.listing).toMatchObject({ status: "sold", expiresAt: before.expiresAt!.toISOString() });
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete" });
    const stored = (await getListing(id))!;
    expect(stored.purgeAt!.getTime()).toBeGreaterThan(Date.now() + 300 * DAY_MS);
    const ended = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=ended", { member: owner });
    expect(ended.body.listings.map((listing) => listing.id)).toEqual([id]);
  });

  it("refuses the transitions the lifecycle forbids with 409 conflict", async () => {
    const owner = await member();
    const { id } = await published(owner);
    const draft = (await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} })).body.id;

    const attempts: [Handler, string, string][] = [
      [resume, id, "resume"], // published -> resume
      [renew, id, "renew"], // 60 days left: not yet
      [pause, draft, "pause"],
      [sold, draft, "sold"],
      [resume, draft, "resume"],
      [renew, draft, "renew"],
    ];
    for (const [handler, target, action] of attempts) {
      const result = await act(handler, owner, target, action);
      expect(result.status, `${target === id ? "published" : "draft"} -> ${action}`).toBe(409);
      expect(result.body.error.code).toBe("conflict");
    }
    expect((await act(sold, owner, id, "sold")).status).toBe(200);
    for (const [handler, action] of [[pause, "pause"], [resume, "resume"], [sold, "sold"], [renew, "renew"]] as const) {
      expect((await act(handler, owner, id, action)).status, `sold -> ${action}`).toBe(409);
    }
    // Edits are closed on a sold listing; removal stays possible.
    expect((await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vendu mais modifié" } })).status).toBe(409);
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(204);
    expect((await getListing(id))?.status).toBe("removed");
  });

  it("answers 404 to another member on every action", async () => {
    const owner = await member();
    const stranger = await member();
    const { id } = await published(owner);
    for (const [handler, action] of [[pause, "pause"], [resume, "resume"], [sold, "sold"], [renew, "renew"]] as const) {
      const result = await act(handler, stranger, id, action);
      expect(result.status, action).toBe(404);
    }
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: stranger })).status).toBe(404);
    expect((await api(pause, "POST", `/api/listings/${id}/pause`)).status).toBe(401);
    expect((await getListing(id))?.status).toBe("published");
  });
});

describe("renew", () => {
  it("renews an expired listing and a published one in its last week, for a new lifetime", async () => {
    const owner = await member();
    const { id } = await published(owner);
    const now = new Date();
    // The expiry job (phase 4) has run: expired a day ago, purge in a year.
    await updateListing(id, { status: "expired", expiresAt: new Date(now.getTime() - DAY_MS), purgeAt: new Date(now.getTime() + 365 * DAY_MS) });
    const listed = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=ended", { member: owner });
    expect(listed.body.listings.map((listing) => [listing.status, listing.canRenew])).toEqual([["expired", true]]);

    const renewed = await act(renew, owner, id, "renew");
    expect(renewed.status).toBe(200);
    expect(renewed.body.listing.status).toBe("published");
    expect(Date.parse(renewed.body.listing.expiresAt!)).toBeGreaterThan(now.getTime() + 59 * DAY_MS);
    const stored = (await getListing(id))!;
    expect(stored.sortAt.getTime()).toBeGreaterThanOrEqual(now.getTime() - 1000);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: stored.version });

    // Published, six days left: the owner may renew early (D16).
    await updateListing(id, { expiresAt: new Date(now.getTime() + 6 * DAY_MS) });
    const early = await act(renew, owner, id, "renew");
    expect(early.status).toBe(200);
    expect(Date.parse(early.body.listing.expiresAt!)).toBeGreaterThan(now.getTime() + 59 * DAY_MS);
  });
});

describe("remove", () => {
  it("removes a published listing: search delete, purge date; the photos wait for the listing's purge", async () => {
    const owner = await member();
    const { id, upload } = await published(owner);
    const uploadPurge = (await getUpload(upload))!.purgeAt;
    const before = Date.now();
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(204);
    const stored = (await getListing(id))!;
    expect(stored.status).toBe("removed");
    expect(stored.purgeAt!.getTime()).toBeGreaterThan(before + 300 * DAY_MS);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete", version: stored.version });
    // §5 / §7: text and photos are purged together at the listing's purgeAt, never at removal.
    expect((await getUpload(upload))?.purgeAt).toEqual(uploadPurge);
    // Removed is final for the owner.
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(409);
    expect((await act(pause, owner, id, "pause")).status).toBe(409);
  });
});

describe("edits after publication", () => {
  it("re-screens an expired listing's edit: blockers refused (422), a clean edit stays expired, logged and revalidated", async () => {
    const owner = await member();
    const { id } = await published(owner);
    await expire(id);
    const before = (await getListing(id))!;

    const phone = await api<Invalid>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { description: PHONE_TEXT } });
    expect(phone.status).toBe(422);
    expect(phone.body.error.code).toBe("invalid_listing");
    expect(codesOf(phone.body.error.details)).toEqual(["description:phone_in_text"]);
    // Drafts may keep a short title; a listing published before must stay publishable.
    const short = await api<Invalid>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo" } });
    expect(short.status).toBe(422);
    expect(codesOf(short.body.error.details)).toEqual(["title:title_min"]);
    expect((await getListing(id))?.version).toBe(before.version);

    revalidateMock.mockClear();
    const clean = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo de ville Peugeot révisé" } });
    expect(clean.status).toBe(200);
    expect(clean.body.listing).toMatchObject({ status: "expired", title: "Vélo de ville Peugeot révisé" });
    const stored = (await getListing(id))!;
    expect(stored.moderation).toMatchObject({ state: "auto_ok", flags: [] });
    expect(revalidateMock).toHaveBeenCalledWith(expect.objectContaining({ slugId: before.slugId }));
    expect(await listContentOps(listingContentRef(id))).toEqual(expect.arrayContaining([expect.objectContaining({ op: "listing.update", ip: owner.jar.ip })]));
  });

  it("holds a flagged edit of an expired listing in pending_review, with one decision", async () => {
    const owner = await member();
    const { id } = await published(owner);
    await expire(id);
    const held = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE } });
    expect(held.status).toBe(200);
    expect(held.body.listing.status).toBe("pending_review");
    const stored = (await getListing(id))!;
    expect(stored.moderation).toMatchObject({ state: "needs_review", flags: ["prohibited_soft"] });
    expect(await decisionsFor(id)).toEqual([stored.moderation.lastDecisionId]);
    expect(lastMail(sendMail, "listingPendingReview", owner.email)?.data).toMatchObject({ listingId: id });
  });

  it("holds a flagged edit of a paused listing: pending_review, no 500, exactly one decision", async () => {
    const owner = await member();
    const { id } = await published(owner);
    expect((await act(pause, owner, id, "pause")).status).toBe(200);
    const held = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE } });
    expect(held.status).toBe(200);
    expect(held.body.listing.status).toBe("pending_review");
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "pending_review", adsEligible: false, moderation: expect.objectContaining({ state: "needs_review", flags: ["prohibited_soft"] }) });
    const decisions = await decisionsFor(id);
    expect(decisions).toEqual([stored.moderation.lastDecisionId]);
    expect(await getModerationDecision(decisions[0]!)).toMatchObject({ action: "restrict_visibility", decidedBy: "system", templateId: "listingPendingReview" });
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete", version: stored.version });
  });

  it("revalidates the public page of a paused listing on a plain edit", async () => {
    const owner = await member();
    const { id } = await published(owner);
    expect((await act(pause, owner, id, "pause")).status).toBe(200);
    revalidateMock.mockClear();
    const edited = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { priceNegotiable: false } });
    expect(edited.status).toBe(200);
    expect(edited.body.listing.status).toBe("paused");
    expect(revalidateMock).toHaveBeenCalledWith(expect.objectContaining({ slugId: (await getListing(id))!.slugId }));
  });

  it("screens the district of a live listing (422 on a phone number)", async () => {
    const owner = await member();
    const { id } = await published(owner);
    const before = (await getListing(id))!;
    const result = await api<Invalid>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { location: { regionCode: "06", citySlug: "casablanca", district: "Maarif 0612345678" } } });
    expect(result.status).toBe(422);
    expect(codesOf(result.body.error.details)).toEqual(["location.district:phone_in_text"]);
    expect((await getListing(id))?.version).toBe(before.version);
    const plain = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { location: { regionCode: "06", citySlug: "casablanca", district: "Maarif" } } });
    expect(plain.status).toBe(200);
    expect(plain.body.listing).toMatchObject({ status: "published", location: { district: "Maarif" } });
  });
});

describe("saves that change nothing", () => {
  it("write nothing on a published listing: no version, searchOutbox or contentOps entry, no revalidation", async () => {
    const owner = await member();
    const { id, upload } = await published(owner);
    const before = (await getListing(id))!;
    const outbox = await getSearchOutbox(id);
    const ops = (await listContentOps(listingContentRef(id))).length;
    revalidateMock.mockClear();
    for (const body of [{}, readyPatch(), { photos: [upload] }, { location: { regionCode: "06", citySlug: "casablanca" } }]) {
      const result = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body });
      expect(result.status, JSON.stringify(body)).toBe(200);
      expect(result.body.listing).toMatchObject({ status: "published", version: before.version });
    }
    expect(await getListing(id)).toEqual(before);
    expect(await getSearchOutbox(id)).toEqual(outbox);
    expect(await listContentOps(listingContentRef(id))).toHaveLength(ops);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("do not screen or hold a paused or expired listing again; a changed screened field is screened", async () => {
    const owner = await member();
    const { id } = await published(owner);
    expect((await act(pause, owner, id, "pause")).status).toBe(200);
    // Stored before the rule applied: resending it unchanged is not an edit to review.
    await updateListing(id, { title: SOFT_TITLE });
    const paused = (await getListing(id))!;
    const same = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE } });
    expect(same.body.listing).toMatchObject({ status: "paused", version: paused.version });
    await expire(id);
    const expired = (await getListing(id))!;
    const resent = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE, price: 1500 } });
    expect(resent.body.listing).toMatchObject({ status: "expired", version: expired.version });
    expect(await decisionsFor(id)).toEqual([]);
    expect(lastMail(sendMail, "listingPendingReview", owner.email)).toBeUndefined();

    // A changed screened field screens the listing, the stored title with it.
    const held = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE, price: 1400 } });
    expect(held.body.listing).toMatchObject({ status: "pending_review", price: 1400 });
    expect(await decisionsFor(id)).toEqual([(await getListing(id))!.moderation.lastDecisionId]);
  });
});

describe("renewal of an expired listing (screened like a publication)", () => {
  it("publishes a clean edited listing again (auto_ok)", async () => {
    const owner = await member();
    const { id } = await published(owner);
    await expire(id);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 1400 } })).status).toBe(200);
    const renewed = await act(renew, owner, id, "renew");
    expect(renewed.status).toBe(200);
    expect(renewed.body.listing.status).toBe("published");
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ sortSource: "renew", adsEligible: true, moderation: expect.objectContaining({ state: "auto_ok" }) });
    expect(stored.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY_MS);
  });

  it("refuses content with a hard blocker (422) and leaves the listing expired", async () => {
    const owner = await member();
    const { id } = await published(owner);
    await expire(id);
    // Stored before the rule applied (or by an older screen): the renewal screens it again.
    await updateListing(id, { description: PHONE_TEXT });
    const before = (await getListing(id))!;
    const refused = await act(renew, owner, id, "renew");
    expect(refused.status).toBe(422);
    expect(codesOf((refused.body as unknown as Invalid).error.details)).toEqual(["description:phone_in_text"]);
    expect(await getListing(id)).toMatchObject({ status: "expired", version: before.version });
  });

  it("holds flagged content in pending_review: one decision, statement mailed, the approval dates the new lifetime", async () => {
    const owner = await member();
    const { id } = await published(owner);
    await expire(id);
    await updateListing(id, { title: SOFT_TITLE });
    const before = (await getListing(id))!;
    const held = await act(renew, owner, id, "renew");
    expect(held.status).toBe(200);
    expect(held.body.listing.status).toBe("pending_review");
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "pending_review", sortSource: "renew", adsEligible: false, moderation: expect.objectContaining({ state: "needs_review", flags: ["prohibited_soft"] }) });
    // The lapsed expiry goes: the approval dates the new lifetime (and reads the hold as a renewal).
    expect(before.expiresAt).toBeDefined();
    expect(stored.expiresAt).toBeUndefined();
    expect(stored.purgeAt).toEqual(before.purgeAt);
    expect(await decisionsFor(id)).toEqual([stored.moderation.lastDecisionId]);
    expect(lastMail(sendMail, "listingPendingReview", owner.email)?.data).toMatchObject({ listingId: id, statement: { measure: "hold", facts: ["prohibited_soft"] } });
  });
});

describe("renewal of content a moderator approved", () => {
  /** Expired, flagged content a moderator approved (an edit held then approved back to expired). */
  async function approvedExpired(owner: Member, overrides: { title?: string; description?: string } = {}): Promise<string> {
    const { id } = await published(owner);
    await expire(id);
    const current = (await getListing(id))!;
    await updateListing(id, { title: SOFT_TITLE, ...overrides, moderation: { ...current.moderation, state: "human_ok", flags: ["prohibited_soft"], reviewedBy: "moderator-1", reviewedAt: new Date() } });
    return id;
  }

  it("publishes it again without a new hold while nobody edited it since; other edits keep the approval", async () => {
    const owner = await member();
    const id = await approvedExpired(owner);
    // Not a screened field: the approval still covers the content.
    const edited = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { priceNegotiable: false } });
    expect(edited.status).toBe(200);
    const before = (await getListing(id))!;
    expect([before.status, before.moderation.state]).toEqual(["expired", "human_ok"]);

    const renewed = await act(renew, owner, id, "renew");
    expect(renewed.status).toBe(200);
    expect(renewed.body.listing.status).toBe("published");
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "published", sortSource: "renew", adsEligible: true });
    expect(stored.moderation).toEqual(before.moderation);
    expect(stored.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY_MS);
    expect(await decisionsFor(id)).toEqual([]);
    expect(lastMail(sendMail, "listingPendingReview", owner.email)).toBeUndefined();
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: stored.version });
  });

  it("still refuses a hard blocker (422)", async () => {
    const owner = await member();
    const id = await approvedExpired(owner, { description: PHONE_TEXT });
    const before = (await getListing(id))!;
    const refused = await act(renew, owner, id, "renew");
    expect(refused.status).toBe(422);
    expect(codesOf((refused.body as unknown as Invalid).error.details)).toEqual(["description:phone_in_text"]);
    expect(await getListing(id)).toMatchObject({ status: "expired", version: before.version });
  });

  it("screens an edit made after the approval again: a flagged one is held, the approval is gone", async () => {
    const owner = await member();
    const id = await approvedExpired(owner);
    const edited = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { price: 1400 } });
    expect(edited.status).toBe(200);
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "pending_review", moderation: expect.objectContaining({ state: "needs_review", flags: ["prohibited_soft"] }) });
    expect(await decisionsFor(id)).toEqual([stored.moderation.lastDecisionId]);
  });
});

describe("active quota on resume and renewal", () => {
  it("refuses to resume or renew past the active quota (409 listing_limit)", { timeout: 60_000 }, async () => {
    const owner = await member();
    const { id } = await published(owner);
    expect((await act(pause, owner, id, "pause")).status).toBe(200);
    // 20 other active listings (the individual quota): bare documents are enough for the count.
    const fillers = Array.from({ length: 20 }, (_, index) => `${id}-fill-${index}`);
    await Promise.all(fillers.map((filler) => listingRef(filler).set({ ownerUid: owner.uid, status: "published" })));
    try {
      const resumed = await act(resume, owner, id, "resume");
      expect(resumed.status).toBe(409);
      expect(resumed.body.error.code).toBe("listing_limit");
      expect((await getListing(id))?.status).toBe("paused");

      // A flagged edit would hold it in pending_review, which takes a slot too.
      const held = await api<ErrorBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: SOFT_TITLE } });
      expect(held.status).toBe(409);
      expect(held.body.error.code).toBe("listing_limit");
      expect(await decisionsFor(id)).toEqual([]);

      await expire(id);
      const renewed = await act(renew, owner, id, "renew");
      expect(renewed.status).toBe(409);
      expect(renewed.body.error.code).toBe("listing_limit");
      expect((await getListing(id))?.status).toBe("expired");
    } finally {
      await Promise.all(fillers.map((filler) => deleteListingDocument(filler)));
    }
    // A free slot again: the renewal goes through.
    expect((await act(renew, owner, id, "renew")).status).toBe(200);
  });
});
