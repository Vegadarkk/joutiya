import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// KYBC pieces of a Pro application (phase 7 design §4) against the Firebase emulators and an
// in-memory object store: presigned PUT to the quarantine bucket, then `complete` checks the size
// and the magic bytes and moves the piece to the private bucket; a piece of someone else is a 404.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as complete } from "@/app/api/pro/kybc/uploads/[id]/complete/route";
import { POST as sign } from "@/app/api/pro/kybc/uploads/route";
import type { KybcCompleteResponse, KybcSignResponse } from "@/lib/contracts/pro";
import { getUpload } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { api, member, type ErrorBody, type Handler, type Member } from "../listings/helpers";

const store = new MemoryObjectStore();
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  store.clear();
});

async function signPiece(owner: Member, declaredType = "application/pdf", declaredSize = PDF.byteLength) {
  return api<KybcSignResponse & ErrorBody>(sign, "POST", "/api/pro/kybc/uploads", { member: owner, body: { declaredType, declaredSize } });
}

/** Calls complete with the `[id]` param (the listings helper only reads /api/listings ids). */
async function completePiece(owner: Member, id: string) {
  const handler: Handler = (request, context) => complete(request, { params: context.params.then(() => ({ id })) });
  return api<KybcCompleteResponse & ErrorBody>(handler, "POST", `/api/pro/kybc/uploads/${id}/complete`, { member: owner });
}

describe("KYBC pieces", () => {
  it("stores a PDF in the private bucket", async () => {
    const owner = await member();
    const signed = await signPiece(owner);
    expect(signed.status).toBe(201);
    const id = signed.body.uploadId;
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "application/pdf" });

    const done = await completePiece(owner, id);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: "ready", uploadId: id });
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).toMatchObject({ size: PDF.byteLength });
    expect(await store.head("quarantine", `uploads/${id}`)).toBeNull();
    expect(await getUpload(id)).toMatchObject({ status: "ready", purpose: "kyb", bucket: "private", finalKey: `kyb/${owner.uid}/${id}`, size: PDF.byteLength });

    const again = await completePiece(owner, id);
    expect(again.body).toEqual({ status: "ready", uploadId: id });
  });

  it("rejects bytes that do not match the declared type", async () => {
    const owner = await member();
    const signed = await signPiece(owner, "image/jpeg");
    const id = signed.body.uploadId;
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "image/jpeg" });
    const done = await completePiece(owner, id);
    expect(done.body).toEqual({ status: "rejected", uploadId: id, reason: "bad_type" });
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).toBeNull();
  });

  it("rejects an object larger than declared", async () => {
    const owner = await member();
    const signed = await signPiece(owner, "application/pdf", 10);
    const id = signed.body.uploadId;
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "application/pdf" });
    expect((await completePiece(owner, id)).body).toEqual({ status: "rejected", uploadId: id, reason: "too_large" });
  });

  it("answers 409 before the PUT, then completes once it lands", async () => {
    const owner = await member();
    const id = (await signPiece(owner)).body.uploadId;
    const early = await completePiece(owner, id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("upload_not_ready");
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "application/pdf" });
    expect((await completePiece(owner, id)).body.status).toBe("ready");
  });

  it("refuses other types at signing and hides someone else's piece", async () => {
    const owner = await member();
    expect((await signPiece(owner, "image/webp")).status).toBe(400);
    expect((await signPiece(owner, "text/html")).status).toBe(400);
    const id = (await signPiece(owner)).body.uploadId;
    const other = await member();
    expect((await completePiece(other, id)).status).toBe(404);
  });
});
