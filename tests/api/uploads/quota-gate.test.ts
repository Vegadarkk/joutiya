import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Degraded Firestore writes (§2 "Garde-fous de quotas", src/lib/quota/gate.ts): photo uploads are
// part of the deposit, so signing and completing answer 503 quota_exhausted with a Retry-After at
// the reset, before any Firestore write or presigned URL; status and deletion stay open.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/db/repositories/uploads", { spy: true });

import { POST as complete } from "@/app/api/uploads/[id]/complete/route";
import { DELETE as remove, GET as status } from "@/app/api/uploads/[id]/route";
import { POST as sign } from "@/app/api/uploads/sign/route";
import type { SignUploadResponse, UploadStatusResponse } from "@/lib/contracts/media";
import { countUploadsByTarget, createUpload, getUpload, transitionUpload } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import type * as Quota from "@/lib/quota";
import { firstDegraded } from "@/lib/quota";
import { QUOTA_ERROR_CODE } from "@/lib/quota/gate";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { call, draft, member, plainJpeg, type ErrorBody, type Member } from "./helpers";

const store = new MemoryObjectStore();

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  store.clear();
  vi.mocked(firstDegraded).mockReset();
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

const signFor = (owner: Member, targetId: string) =>
  call<SignUploadResponse & ErrorBody>(sign, "POST", "/api/uploads/sign", { member: owner, body: { purpose: "listing", targetId, declaredSize: 350_000, declaredType: "image/jpeg" } });

function expectQuotaRefusal(result: { status: number; body: ErrorBody; response: Response }): void {
  expect([result.status, result.body.error.code]).toEqual([503, QUOTA_ERROR_CODE]);
  expect(QUOTA_ERROR_CODE).toBe("quota_exhausted");
  expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(60);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
}

describe("uploads with degraded Firestore writes", () => {
  it("refuses a signature before the upload document and the presigned URL, then signs after the reset", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    vi.mocked(createUpload).mockClear();
    store.calls.length = 0;

    expectQuotaRefusal(await signFor(owner, listingId));
    expect(firstDegraded).toHaveBeenCalledWith(["firestore.writes"]);
    expect(createUpload).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expect(await countUploadsByTarget(listingId)).toBe(0);

    vi.mocked(firstDegraded).mockResolvedValue(null);
    const signed = await signFor(owner, listingId);
    expect(signed.status).toBe(201);
    expect((await getUpload(signed.body.uploadId))?.status).toBe("signed");
  });

  it("refuses to complete before any transition, while status and deletion stay open", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const signed = await signFor(owner, listingId);
    expect(signed.status).toBe(201);
    const id = signed.body.uploadId;
    store.seed("quarantine", `uploads/${id}`, await plainJpeg(), { contentType: "image/jpeg" });

    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    vi.mocked(transitionUpload).mockClear();
    expectQuotaRefusal(await call<UploadStatusResponse & ErrorBody>(complete, "POST", `/api/uploads/${id}/complete`, { member: owner, body: {} }));
    expect(transitionUpload).not.toHaveBeenCalled();
    expect((await getUpload(id))?.status).toBe("signed");

    const polled = await call<UploadStatusResponse>(status, "GET", `/api/uploads/${id}`, { member: owner });
    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe("processing");
    expect((await call(remove, "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(204);
    expect(await getUpload(id)).toBeNull();
  });
});
