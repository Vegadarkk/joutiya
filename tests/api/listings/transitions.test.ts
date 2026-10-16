import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Owner actions on a published listing (lifecycle §5, D16): pause / resume / sold / renew / remove
// through the API, the forbidden transitions (409 conflict), the search outbox and audit effects.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as create } from "@/app/api/listings/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import { POST as sold } from "@/app/api/listings/[id]/sold/route";
import type { CreateListingResponse, OwnerListingsResponse } from "@/lib/contracts/listings";
import { getListing, updateListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { getUpload } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

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
  it("removes a published listing: search delete, purge date, uploads scheduled", async () => {
    const owner = await member();
    const { id, upload } = await published(owner);
    const before = Date.now();
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(204);
    const stored = (await getListing(id))!;
    expect(stored.status).toBe("removed");
    expect(stored.purgeAt!.getTime()).toBeGreaterThan(before);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete", version: stored.version });
    expect((await getUpload(upload))?.purgeAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Removed is final for the owner.
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(409);
    expect((await act(pause, owner, id, "pause")).status).toBe(409);
  });
});
