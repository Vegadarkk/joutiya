import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Per-account limiters of the owner's listing routes (src/config/rate-limits.ts): the Spark daily
// quotas (20 000 writes, 50 000 reads) are shared by the whole site. Each budget is pre-spent
// through the real limiter, then the next call answers the standard 429 envelope without reaching
// Firestore; another account keeps its own budget.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/repositories/listings", { spy: true });
vi.mock("@/lib/listings/service", { spy: true });

import { RATE_LIMITS } from "@/config/rate-limits";
import { POST as create } from "@/app/api/listings/route";
import { GET as mine } from "@/app/api/listings/mine/route";
import { DELETE as remove, GET as read, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import { POST as sold } from "@/app/api/listings/[id]/sold/route";
import type { CreateListingResponse, OwnerListingsResponse } from "@/lib/contracts/listings";
import { getListing, listOwnerListings } from "@/lib/db/repositories/listings";
import { resetServerEnv } from "@/lib/env";
import { changeStatus, createDraft } from "@/lib/listings/service";
import { consumeLimit, limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { api, member, readyPatch, seedReadyUpload, type ApiResult, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

const newDraft = (owner: Member) => api<CreateListingResponse & ErrorBody>(create, "POST", "/api/listings", { member: owner, body: {} });

async function published(owner: Member): Promise<string> {
  const id = (await newDraft(owner)).body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.body.status).toBe("published");
  return id;
}

/** Spends what is left of `id`'s budget for `owner` but `keep` points. */
async function spend(id: keyof typeof RATE_LIMITS, owner: Member, keep = 0): Promise<void> {
  const used = (await limitState(id, owner.uid))?.consumedPoints ?? 0;
  const points = RATE_LIMITS[id].points - used - keep;
  if (points > 0) expect((await consumeLimit(id, owner.uid, points)).ok).toBe(true);
}

function expectLimited(result: ApiResult<ErrorBody>): void {
  expect([result.status, result.body.error.code]).toEqual([429, "rate_limited"]);
  expect(Number(result.header("retry-after"))).toBeGreaterThan(0);
}

const act = (handler: Handler, owner: Member, id: string, action: string) => api<ListingBody & ErrorBody>(handler, "POST", `/api/listings/${id}/${action}`, { member: owner });

describe("POST /api/listings (listing.new.uid)", () => {
  it("allows 20 new drafts a day per account, then 429 before any write", async () => {
    expect(RATE_LIMITS["listing.new.uid"]).toMatchObject({ points: 20, policy: "open" });
    const owner = await member();
    expect((await newDraft(owner)).status).toBe(201);
    await spend("listing.new.uid", owner, 1);
    expect((await newDraft(owner)).status).toBe(201);

    vi.mocked(createDraft).mockClear();
    expectLimited(await newDraft(owner));
    expect(createDraft).not.toHaveBeenCalled();
    expect(await listOwnerListings(owner.uid, "drafts")).toHaveLength(2);
    // The publication limit (listing.create.uid, at publish) is a separate budget.
    expect((await limitState("listing.create.uid", owner.uid))?.consumedPoints ?? 0).toBe(0);
    expect((await newDraft(await member())).status).toBe(201);
  });
});

describe("DELETE /api/listings/{id} and pause / resume / sold / renew (listing.status.uid)", () => {
  it("share 120 status changes a day per account, then 429 with the listing untouched", async () => {
    expect(RATE_LIMITS["listing.status.uid"]).toMatchObject({ points: 120, policy: "open" });
    const owner = await member();
    const id = await published(owner);
    const draft = (await newDraft(owner)).body.id;
    expect((await act(pause, owner, id, "pause")).status).toBe(200);
    expect((await limitState("listing.status.uid", owner.uid))?.consumedPoints).toBe(1);
    await spend("listing.status.uid", owner, 1);
    expect((await act(resume, owner, id, "resume")).status).toBe(200);

    vi.mocked(changeStatus).mockClear();
    expectLimited(await act(pause, owner, id, "pause"));
    expectLimited(await act(sold, owner, id, "sold"));
    expectLimited(await act(renew, owner, id, "renew"));
    expectLimited(await act(resume, owner, id, "resume"));
    expectLimited(await api<ErrorBody>(remove, "DELETE", `/api/listings/${draft}`, { member: owner }));
    expect(changeStatus).not.toHaveBeenCalled();
    expect((await getListing(id))?.status).toBe("published");
    expect((await getListing(draft))?.status).toBe("draft");

    // Another account is not affected.
    const other = await member();
    const otherDraft = (await newDraft(other)).body.id;
    expect((await api(remove, "DELETE", `/api/listings/${otherDraft}`, { member: other })).status).toBe(204);
  });

  it("counts refused calls too (they read the listing): a 409 for the owner, a 404 for anyone else", async () => {
    const owner = await member();
    const other = await member();
    const draft = (await newDraft(owner)).body.id;
    expect((await act(resume, owner, draft, "resume")).status).toBe(409);
    expect((await act(pause, other, draft, "pause")).status).toBe(404);
    expect((await limitState("listing.status.uid", owner.uid))?.consumedPoints).toBe(1);
    expect((await limitState("listing.status.uid", other.uid))?.consumedPoints).toBe(1);
  });
});

describe("GET /api/listings/{id} and /mine (listing.owner.read.uid)", () => {
  it("charge the documents read: the listing and its photos, one per listed row", async () => {
    expect(RATE_LIMITS["listing.owner.read.uid"]).toMatchObject({ points: 5000, policy: "open" });
    const owner = await member();
    const id = (await newDraft(owner)).body.id;
    await newDraft(owner);
    const used = async () => (await limitState("listing.owner.read.uid", owner.uid))?.consumedPoints ?? 0;

    expect((await api<ListingBody>(read, "GET", `/api/listings/${id}`, { member: owner })).status).toBe(200);
    expect(await used()).toBe(1);
    const photos = [await seedReadyUpload(owner, id), await seedReadyUpload(owner, id)];
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos } })).status).toBe(200);
    const withPhotos = await api<ListingBody>(read, "GET", `/api/listings/${id}`, { member: owner });
    expect(withPhotos.body.listing.photos).toHaveLength(2);
    expect(await used()).toBe(1 + 3);

    const drafts = await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=drafts", { member: owner });
    expect(drafts.body.listings).toHaveLength(2);
    expect(await used()).toBe(4 + 2);
    // An empty tab still costs one read; someone else's listing (404) costs the lookup.
    expect((await api<OwnerListingsResponse>(mine, "GET", "/api/listings/mine?status=ended", { member: owner })).body.listings).toEqual([]);
    expect(await used()).toBe(6 + 1);
    expect((await api(read, "GET", `/api/listings/${(await newDraft(await member())).body.id}`, { member: owner })).status).toBe(404);
    expect(await used()).toBe(7 + 1);
  });

  it("answers 429 once the daily budget is spent, before any Firestore read", async () => {
    const owner = await member();
    const id = (await newDraft(owner)).body.id;
    await spend("listing.owner.read.uid", owner, 1);
    expect((await api(read, "GET", `/api/listings/${id}`, { member: owner })).status).toBe(200);

    vi.mocked(getListing).mockClear();
    vi.mocked(listOwnerListings).mockClear();
    expectLimited(await api<ErrorBody>(read, "GET", `/api/listings/${id}`, { member: owner }));
    expectLimited(await api<ErrorBody>(mine, "GET", "/api/listings/mine?status=drafts", { member: owner }));
    expect(getListing).not.toHaveBeenCalled();
    expect(listOwnerListings).not.toHaveBeenCalled();
    // A malformed query is refused first and costs nothing.
    expect((await api(mine, "GET", "/api/listings/mine?status=nope", { member: owner })).status).toBe(400);

    const other = await member();
    expect((await api(mine, "GET", "/api/listings/mine?status=drafts", { member: other })).status).toBe(200);
  });
});
