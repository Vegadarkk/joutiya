import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// KYBC pieces of a Pro application (phase 7 design §4) against the Firebase emulators and an
// in-memory object store: presigned PUT to the quarantine bucket (eligible accounts only), then
// `complete` checks the size and the magic bytes, refuses a PDF with active content, strips the
// metadata of an image and moves the piece to the private bucket; the owner deletes a piece no
// application under review lists; the photo routes never see a piece; someone else's is a 404.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { DELETE as remove } from "@/app/api/pro/kybc/uploads/[id]/route";
import { POST as complete } from "@/app/api/pro/kybc/uploads/[id]/complete/route";
import { POST as sign } from "@/app/api/pro/kybc/uploads/route";
import { DELETE as photoDelete, GET as photoStatus } from "@/app/api/uploads/[id]/route";
import { POST as photoComplete } from "@/app/api/uploads/[id]/complete/route";
import type { KybcCompleteResponse, KybcSignResponse } from "@/lib/contracts/pro";
import { getUpload } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { api, freshPhone, member, type ErrorBody, type Handler, type Member } from "../listings/helpers";
import { application, applyAs, code, withWhatsApp } from "./helpers";

const store = new MemoryObjectStore();
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const ACTIVE_PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj\ntrailer\n<<>>\n%%EOF\n");

beforeAll(() => {
  resetServerEnv();
  setObjectStoreForTests(store);
});
afterAll(() => resetObjectStore());
beforeEach(() => {
  resetRateLimiters();
  store.clear();
});

const applicant = () => member({ phone: freshPhone() });

async function signPiece(owner: Member, declaredType = "application/pdf", declaredSize = PDF.byteLength) {
  return api<KybcSignResponse & ErrorBody>(sign, "POST", "/api/pro/kybc/uploads", { member: owner, body: { declaredType, declaredSize } });
}

/** Routes with an `[id]` param (the listings helper only reads /api/listings ids). */
const withId = (handler: Handler, id: string): Handler => (request, context) => handler(request, { params: context.params.then(() => ({ id })) });

async function completePiece(owner: Member, id: string) {
  return api<KybcCompleteResponse & ErrorBody>(withId(complete, id), "POST", `/api/pro/kybc/uploads/${id}/complete`, { member: owner });
}

const removePiece = (owner: Member, id: string) => api<ErrorBody | null>(withId(remove, id), "DELETE", `/api/pro/kybc/uploads/${id}`, { member: owner });

/** A piece signed, PUT and completed. */
async function readyPiece(owner: Member, bytes: Uint8Array = PDF, declaredType = "application/pdf"): Promise<string> {
  const id = (await signPiece(owner, declaredType, bytes.byteLength)).body.uploadId;
  await store.put("quarantine", `uploads/${id}`, bytes, { contentType: declaredType });
  expect((await completePiece(owner, id)).body.status).toBe("ready");
  return id;
}

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 12, height: 8, channels: 3, background: "#b8742f" } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "Atlas Vélos", ImageDescription: "scan" } } })
    .toBuffer();
}

describe("KYBC pieces", () => {
  it("stores a PDF in the private bucket", async () => {
    const owner = await applicant();
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

  it("signs for eligible accounts only (same gates as the application)", async () => {
    const noPhone = await member();
    const refused = await withWhatsApp(() => signPiece(noPhone));
    expect(refused.status).toBe(403);
    expect(code(refused.body)).toBe("phone_required");
    // Without the WhatsApp check the number is verified by the moderator's call during the review.
    expect((await signPiece(noPhone)).status).toBe(201);
    const pending = await applicant();
    await applyAs(pending, application([await readyPiece(pending)]));
    const busy = await signPiece(pending);
    expect(busy.status).toBe(409);
    expect(code(busy.body)).toBe("pro_application_exists");
  });

  it("rejects bytes that do not match the declared type", async () => {
    const owner = await applicant();
    const signed = await signPiece(owner, "image/jpeg");
    const id = signed.body.uploadId;
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "image/jpeg" });
    const done = await completePiece(owner, id);
    expect(done.body).toEqual({ status: "rejected", uploadId: id, reason: "bad_type" });
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).toBeNull();
  });

  it("rejects a PDF with active content", async () => {
    const owner = await applicant();
    const id = (await signPiece(owner, "application/pdf", ACTIVE_PDF.byteLength)).body.uploadId;
    await store.put("quarantine", `uploads/${id}`, ACTIVE_PDF, { contentType: "application/pdf" });
    expect((await completePiece(owner, id)).body).toEqual({ status: "rejected", uploadId: id, reason: "active_content" });
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).toBeNull();
    expect(await store.head("quarantine", `uploads/${id}`)).toBeNull();
    expect(await getUpload(id)).toMatchObject({ status: "rejected", rejectReason: "active_content" });
  });

  it("stores an image without its metadata (EXIF, GPS) and a JPEG that is not an image as bad_type", async () => {
    const owner = await applicant();
    const original = await jpegWithExif();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const id = await readyPiece(owner, original, "image/jpeg");
    const stored = await store.get("private", `kyb/${owner.uid}/${id}`);
    expect(stored).not.toBeNull();
    const meta = await sharp(stored!).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 12, height: 8 });
    expect(meta.exif).toBeUndefined();
    expect(await getUpload(id)).toMatchObject({ status: "ready", size: stored!.byteLength });

    const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
    const broken = (await signPiece(owner, "image/jpeg", truncated.byteLength)).body.uploadId;
    await store.put("quarantine", `uploads/${broken}`, truncated, { contentType: "image/jpeg" });
    expect((await completePiece(owner, broken)).body).toEqual({ status: "rejected", uploadId: broken, reason: "bad_type" });
  });

  it("rejects an object larger than declared", async () => {
    const owner = await applicant();
    const signed = await signPiece(owner, "application/pdf", 10);
    const id = signed.body.uploadId;
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "application/pdf" });
    expect((await completePiece(owner, id)).body).toEqual({ status: "rejected", uploadId: id, reason: "too_large" });
  });

  it("answers 409 before the PUT, then completes once it lands", async () => {
    const owner = await applicant();
    const id = (await signPiece(owner)).body.uploadId;
    const early = await completePiece(owner, id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("upload_not_ready");
    await store.put("quarantine", `uploads/${id}`, PDF, { contentType: "application/pdf" });
    expect((await completePiece(owner, id)).body.status).toBe("ready");
  });

  it("refuses other types at signing and hides someone else's piece", async () => {
    const owner = await applicant();
    expect((await signPiece(owner, "image/webp")).status).toBe(400);
    expect((await signPiece(owner, "text/html")).status).toBe(400);
    const id = (await signPiece(owner)).body.uploadId;
    const other = await applicant();
    expect((await completePiece(other, id)).status).toBe(404);
    expect((await removePiece(other, id)).status).toBe(404);
  });

  it("lets the owner delete a piece: objects and document gone, 404 after", async () => {
    const owner = await applicant();
    const id = await readyPiece(owner);
    const removed = await removePiece(owner, id);
    expect(removed.status).toBe(204);
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).toBeNull();
    expect(await getUpload(id)).toBeNull();
    expect((await removePiece(owner, id)).status).toBe(404);
    expect((await completePiece(owner, id)).status).toBe(404);
  });

  it("keeps a piece listed by an application under review (409)", async () => {
    const owner = await applicant();
    const id = await readyPiece(owner);
    const spare = await readyPiece(owner);
    expect((await applyAs(owner, application([id]))).status).toBe(201);
    const kept = await removePiece(owner, id);
    expect(kept.status).toBe(409);
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).not.toBeNull();
    expect((await removePiece(owner, spare)).status).toBe(204);
  });

  it("is invisible to the photo routes (status, complete, delete answer 404)", async () => {
    const owner = await applicant();
    const id = await readyPiece(owner);
    expect((await api(withId(photoStatus, id), "GET", `/api/uploads/${id}`, { member: owner })).status).toBe(404);
    expect((await api(withId(photoComplete, id), "POST", `/api/uploads/${id}/complete`, { member: owner })).status).toBe(404);
    expect((await api(withId(photoDelete, id), "DELETE", `/api/uploads/${id}`, { member: owner })).status).toBe(404);
    expect(await store.head("private", `kyb/${owner.uid}/${id}`)).not.toBeNull();
    expect(await getUpload(id)).toMatchObject({ status: "ready" });
  });
});
