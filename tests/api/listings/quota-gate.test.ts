import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Degraded Firestore writes (§2 "Garde-fous de quotas", quota/gate.ts): the deposit routes
// (create, edit, publish, renew, resume) answer 503 with a Retry-After up front and write
// nothing; pause, sold and removal stay open, since they take a listing down.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/listings/service", { spy: true });

import { POST as create } from "@/app/api/listings/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import { POST as sold } from "@/app/api/listings/[id]/sold/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing, listOwnerListings, updateListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { resetServerEnv } from "@/lib/env";
import { changeStatus, createDraft, patchListing, publish as publishListing } from "@/lib/listings/service";
import type * as Quota from "@/lib/quota";
import { firstDegraded } from "@/lib/quota";
import { QUOTA_ERROR_CODE } from "@/lib/quota/gate";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ApiResult, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "./helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => {
  resetRateLimiters();
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

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

function expectQuotaRefusal(result: ApiResult<ErrorBody>, name: string): void {
  expect([result.status, result.body.error.code], name).toEqual([503, QUOTA_ERROR_CODE]);
  expect(Number(result.header("retry-after")), name).toBeGreaterThanOrEqual(60);
}

describe("listing deposit with degraded Firestore writes", () => {
  it("refuses create, edit, publish, renew and resume before the listing is read or written", { timeout: 60_000 }, async () => {
    const owner = await member();
    const live = await published(owner);
    const paused = await published(owner);
    const expired = await published(owner);
    const draft = await readyDraft(owner);
    expect((await act(pause, owner, paused, "pause")).status).toBe(200);
    const now = Date.now();
    await updateListing(expired, { status: "expired", expiresAt: new Date(now - DAY_MS), purgeAt: new Date(now + 365 * DAY_MS) });
    const before = new Map<string, ListingRecord>();
    for (const id of [live, paused, expired, draft]) before.set(id, (await getListing(id))!);

    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    for (const spy of [createDraft, patchListing, publishListing, changeStatus]) vi.mocked(spy).mockClear();
    expectQuotaRefusal(await api<ErrorBody>(create, "POST", "/api/listings", { member: owner, body: {} }), "create");
    expectQuotaRefusal(await api<ErrorBody>(patch, "PATCH", `/api/listings/${draft}`, { member: owner, body: { title: "Vélo de ville révisé" } }), "draft save");
    expectQuotaRefusal(await api<ErrorBody>(patch, "PATCH", `/api/listings/${live}`, { member: owner, body: { priceNegotiable: false } }), "edit");
    expectQuotaRefusal(await api<ErrorBody>(publish, "POST", `/api/listings/${draft}/publish`, { member: owner, body: { acceptRules: true } }), "publish");
    expectQuotaRefusal(await act(renew, owner, expired, "renew"), "renew");
    expectQuotaRefusal(await act(resume, owner, paused, "resume"), "resume");

    expect(firstDegraded).toHaveBeenCalledWith(["firestore.writes"]);
    for (const spy of [createDraft, patchListing, publishListing, changeStatus]) expect(spy).not.toHaveBeenCalled();
    for (const [id, record] of before) expect(await getListing(id)).toEqual(record);
    expect(await listOwnerListings(owner.uid, "drafts")).toHaveLength(1);

    // Back to normal: the same requests go through.
    vi.mocked(firstDegraded).mockResolvedValue(null);
    expect((await act(resume, owner, paused, "resume")).status).toBe(200);
    expect((await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} })).status).toBe(201);
  });

  it("keeps pause, sold and removal open", { timeout: 60_000 }, async () => {
    const owner = await member();
    const first = await published(owner);
    const second = await published(owner);
    vi.mocked(firstDegraded).mockClear();
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    expect((await act(pause, owner, first, "pause")).status).toBe(200);
    expect((await act(sold, owner, second, "sold")).status).toBe(200);
    expect((await api(remove, "DELETE", `/api/listings/${first}`, { member: owner })).status).toBe(204);
    expect(firstDegraded).not.toHaveBeenCalled();
    expect((await getListing(first))?.status).toBe("removed");
    expect((await getListing(second))?.status).toBe("sold");
  });
});
