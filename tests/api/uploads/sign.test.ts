import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/uploads/sign against the emulators (design §3 MEDIA_API, architecture §6 uploads):
// role matrix, IDOR (someone else's or a read-only listing answers 404), body contract, photo
// limit (attached + in flight), upload cap (3x the photo limit, every document counted), rate
// limits (30 per hour, 200 MiB declared per day), degraded storage (storage_full), the `signed`
// document and the LCEN content operation.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
const storage = vi.hoisted(() => ({ full: false }));
vi.mock("@/lib/uploads/storage-gauge", async (importOriginal) => ({
  ...(await importOriginal<typeof StorageGauge>()),
  isStorageFull: vi.fn(async () => storage.full),
}));

import { DELETE as removeListing } from "@/app/api/listings/[id]/route";
import { DELETE as removeUpload } from "@/app/api/uploads/[id]/route";
import { POST as sign } from "@/app/api/uploads/sign/route";
import { MAX_UPLOAD_BYTES, UPLOAD_ID_PATTERN, UPLOAD_LIMIT_REASON, UPLOAD_URL_TTL_SECONDS, UPLOADS_PER_PHOTO_SLOT, type SignUploadResponse } from "@/lib/contracts/media";
import { listContentOps } from "@/lib/db/repositories/content-ops";
import { countUploadsByTarget, getUpload, listUploadsByTarget } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import type * as StorageGauge from "@/lib/uploads/storage-gauge";
import { attachPhoto, call, draft, listingApi, member, memberWithClaims, seedReadyUpload, type ErrorBody, type Member } from "./helpers";

const store = new MemoryObjectStore();
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  storage.full = false;
  store.clear();
});

const body = (targetId: string, overrides: Record<string, unknown> = {}) => ({ purpose: "listing", targetId, declaredSize: 350_000, declaredType: "image/jpeg", ...overrides });

async function signFor(owner: Member, targetId: string, overrides: Record<string, unknown> = {}) {
  return call<SignUploadResponse & ErrorBody>(sign, "POST", "/api/uploads/sign", { member: owner, body: body(targetId, overrides) });
}

describe("POST /api/uploads/sign", () => {
  it("signs a 5-minute PUT to the quarantine bucket and records the signed upload", async () => {
    const owner = await member();
    const id = await draft(owner);
    const before = Date.now();
    const signed = await signFor(owner, id, { declaredType: "image/webp", declaredSize: 420_000 });
    expect(signed.status).toBe(201);
    expect(signed.response.headers.get("cache-control")).toBe("no-store");
    const { uploadId, url, method, headers, expiresAt } = signed.body;
    expect(uploadId).toMatch(UPLOAD_ID_PATTERN);
    expect(method).toBe("PUT");
    expect(headers).toEqual({ "Content-Type": "image/webp" });
    expect(url.startsWith(`memory://quarantine/uploads/${uploadId}?`)).toBe(true);
    expect(new URL(url).searchParams.get("len")).toBe("420000");
    const ttl = new Date(expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan((UPLOAD_URL_TTL_SECONDS - 5) * 1000);
    expect(ttl).toBeLessThanOrEqual((UPLOAD_URL_TTL_SECONDS + 1) * 1000);
    expect(store.calls).toEqual([{ op: "presignPut", bucket: "quarantine", key: `uploads/${uploadId}` }]);

    const doc = await getUpload(uploadId);
    expect(doc).toMatchObject({ ownerUid: owner.uid, purpose: "listing", targetId: id, declaredSize: 420_000, declaredType: "image/webp", status: "signed", quarantineKey: `uploads/${uploadId}`, bucket: "media", checks: {} });
    const retention = doc!.purgeAt.getTime() - doc!.createdAt.getTime();
    expect(retention).toBe(7 * DAY_MS);
    // LCEN: who uploaded what from which IP, in clear.
    expect(await listContentOps(`uploads/${uploadId}`)).toEqual([expect.objectContaining({ uid: owner.uid, op: "upload.create", ip: owner.jar.ip })]);
  });

  it("needs a session, the Origin header, the CSRF token, an activated and unsuspended account", async () => {
    const owner = await member();
    const id = await draft(owner);
    expect((await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { body: body(id) })).status).toBe(401);
    const noCsrf = await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { member: owner, body: body(id), csrf: false });
    expect([noCsrf.status, noCsrf.body.error.code]).toEqual([403, "csrf"]);
    const noOrigin = await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { member: owner, body: body(id), origin: null });
    expect([noOrigin.status, noOrigin.body.error.code]).toEqual([403, "origin"]);
    const foreign = await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { member: owner, body: body(id), origin: "https://evil.example" });
    expect([foreign.status, foreign.body.error.code]).toEqual([403, "origin"]);

    const pending = await memberWithClaims(null);
    const roleMissing = await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { member: pending, body: body(id) });
    expect([roleMissing.status, roleMissing.body.error.code]).toEqual([403, "role_missing"]);
    const suspended = await memberWithClaims({ role: "individual", st: "suspended" });
    const refused = await call<ErrorBody>(sign, "POST", "/api/uploads/sign", { member: suspended, body: body(id) });
    expect([refused.status, refused.body.error.code]).toEqual([403, "account_suspended"]);
    expect(store.calls).toEqual([]);
  });

  it("answers 404 for someone else's listing, an unknown one and a read-only (removed) one", async () => {
    const owner = await member();
    const stranger = await member();
    const id = await draft(owner);
    expect((await signFor(stranger, id)).status).toBe(404);
    expect((await signFor(owner, "zzzzzzzz")).status).toBe(404);
    expect((await listingApi(removeListing, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(204);
    expect((await signFor(owner, id)).status).toBe(404);
    expect(store.calls).toEqual([]);
  });

  it("validates the body strictly: purpose, target, size and type", async () => {
    const owner = await member();
    const id = await draft(owner);
    const cases: Record<string, unknown>[] = [
      { declaredSize: MAX_UPLOAD_BYTES + 1 },
      { declaredSize: 0 },
      { declaredSize: 12.5 },
      { declaredType: "image/gif" },
      { declaredType: "image/heic" },
      { purpose: "kyb" },
      { targetId: "../../etc" },
      { extra: true },
    ];
    for (const overrides of cases) {
      const result = await signFor(owner, id, overrides);
      expect(result.status, JSON.stringify(overrides)).toBe(400);
      expect(result.body.error.code).toBe("invalid_body");
    }
    expect((await signFor(owner, id, { declaredSize: MAX_UPLOAD_BYTES })).status).toBe(201);
  });

  it("refuses an 11th photo, counting the attached photos and the uploads in flight", async () => {
    const owner = await member();
    const full = await draft(owner);
    for (let i = 0; i < 10; i += 1) await attachPhoto(full, await seedReadyUpload(owner, full));
    const refused = await signFor(owner, full);
    expect([refused.status, refused.body.error.code]).toEqual([409, "photo_limit"]);

    const busy = await draft(owner);
    for (let i = 0; i < 10; i += 1) expect((await signFor(owner, busy)).status).toBe(201);
    expect((await signFor(owner, busy)).body.error.code).toBe("photo_limit");
  });

  it("caps the upload documents of a listing at 3x its photo limit, refused ones included, until some are removed", async () => {
    const owner = await member();
    const id = await draft(owner);
    const cap = UPLOADS_PER_PHOTO_SLOT * 10;
    // Refused photos are kept 7 days: without the cap, each one would be read by every owner GET.
    const refused: string[] = [];
    for (let i = 0; i < cap; i += 1) refused.push(await seedReadyUpload(owner, id, { status: "rejected", rejectReason: "nsfw" }));
    expect(await countUploadsByTarget(id)).toBe(cap);

    const capped = await call<ErrorBody & { error: { details?: unknown } }>(sign, "POST", "/api/uploads/sign", { member: owner, body: body(id) });
    expect([capped.status, capped.body.error.code]).toEqual([409, "photo_limit"]);
    expect(capped.body.error.details).toEqual({ reason: UPLOAD_LIMIT_REASON });
    expect(store.calls).toEqual([]);

    // Removing a refused photo (the wizard's tile) frees a slot.
    expect((await call(removeUpload, "DELETE", `/api/uploads/${refused[0]}`, { member: owner })).status).toBe(204);
    expect((await signFor(owner, id)).status).toBe(201);
    expect((await signFor(owner, id)).body.error.details).toEqual({ reason: UPLOAD_LIMIT_REASON });
  });

  it("bounds the listing's upload query (backstop of the cap)", async () => {
    const owner = await member();
    const id = await draft(owner);
    for (let i = 0; i < 5; i += 1) await seedReadyUpload(owner, id, { status: "rejected", rejectReason: "expired" });
    expect(await listUploadsByTarget(id, undefined, 3)).toHaveLength(3);
    expect(await listUploadsByTarget(id, ["rejected"])).toHaveLength(5);
  });

  it("limits signatures to 30 an hour per account", async () => {
    const owner = await member();
    const drafts = [await draft(owner), await draft(owner), await draft(owner), await draft(owner)];
    for (let i = 0; i < 30; i += 1) expect((await signFor(owner, drafts[Math.floor(i / 10)]!)).status).toBe(201);
    const limited = await signFor(owner, drafts[3]!);
    expect([limited.status, limited.body.error.code]).toEqual([429, "rate_limited"]);
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits the declared bytes to 200 MiB a day per account", async () => {
    const owner = await member();
    const drafts = [await draft(owner), await draft(owner), await draft(owner)];
    for (let i = 0; i < 20; i += 1) expect((await signFor(owner, drafts[Math.floor(i / 10)]!, { declaredSize: MAX_UPLOAD_BYTES })).status).toBe(201);
    const limited = await signFor(owner, drafts[2]!, { declaredSize: 1 });
    expect([limited.status, limited.body.error.code]).toEqual([429, "rate_limited"]);
  });

  it("refuses uploads with storage_full once R2 storage is degraded (D15)", async () => {
    const owner = await member();
    const id = await draft(owner);
    storage.full = true;
    const refused = await signFor(owner, id);
    expect([refused.status, refused.body.error.code]).toEqual([503, "storage_full"]);
    expect(refused.response.headers.get("retry-after")).toBe("3600");
    expect(store.calls).toEqual([]);
  });
});
