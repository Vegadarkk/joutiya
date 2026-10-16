import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Per-account limiter of DELETE /api/uploads/{id} (src/config/rate-limits.ts, upload.delete.uid):
// the Spark daily quotas are shared by the whole site, so the budget is consumed after the id
// check and before the first Firestore read; refused calls (404, 409) count too.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/repositories/uploads", { spy: true });

import { RATE_LIMITS } from "@/config/rate-limits";
import { DELETE as remove } from "@/app/api/uploads/[id]/route";
import { getUpload } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { consumeLimit, limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { call, draft, member, seedReadyUpload, type ErrorBody } from "./helpers";

const store = new MemoryObjectStore();

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  store.clear();
});

describe("DELETE /api/uploads/{id} (upload.delete.uid)", () => {
  it("allows 300 deletions a day per account, refused ones included, then 429 before any read", async () => {
    expect(RATE_LIMITS["upload.delete.uid"]).toMatchObject({ points: 300, policy: "open", key: "uid" });
    const owner = await member();
    const stranger = await member();
    const listingId = await draft(owner);
    const used = async () => (await limitState("upload.delete.uid", owner.uid))?.consumedPoints ?? 0;

    // A malformed id is refused before the limiter; an unknown one reads, so it counts.
    expect((await call(remove, "DELETE", "/api/uploads/not-an-id!", { member: owner })).status).toBe(404);
    expect(await used()).toBe(0);
    expect((await call(remove, "DELETE", "/api/uploads/zzzzzzzzzzzzzzzz", { member: owner })).status).toBe(404);
    expect(await used()).toBe(1);

    const first = await seedReadyUpload(owner, listingId);
    expect((await call(remove, "DELETE", `/api/uploads/${first}`, { member: owner })).status).toBe(204);
    expect(await used()).toBe(2);

    const last = await seedReadyUpload(owner, listingId);
    expect((await consumeLimit("upload.delete.uid", owner.uid, RATE_LIMITS["upload.delete.uid"].points - (await used()))).ok).toBe(true);
    vi.mocked(getUpload).mockClear();
    store.calls.length = 0;
    const limited = await call<ErrorBody>(remove, "DELETE", `/api/uploads/${last}`, { member: owner });
    expect([limited.status, limited.body.error.code]).toEqual([429, "rate_limited"]);
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(getUpload).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expect((await getUpload(last))?.status).toBe("ready");

    // Another account keeps its own budget (and still gets 404 for someone else's upload).
    expect((await call(remove, "DELETE", `/api/uploads/${last}`, { member: stranger })).status).toBe(404);
    expect((await limitState("upload.delete.uid", stranger.uid))?.consumedPoints).toBe(1);
  });
});
