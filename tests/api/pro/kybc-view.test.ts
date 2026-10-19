import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Staff view of a KYBC piece, GET /kybc/{proId}/{pieceId} on the admin host (phase 7 design §4):
// the only route that serves identity documents. Admin host only, Access identity and staff
// session, a piece the application lists and the owner uploaded as `kyb`; the view is journaled
// before the bytes leave; PDFs download, images display inline, nothing is cached.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { GET as view } from "@/app/admin/kybc/[proId]/[pieceId]/route";
import { proProfileRef } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { MemoryObjectStore, resetObjectStore, setObjectStoreForTests } from "@/lib/storage";
import { freshPhone, member, type Handler, type Member } from "../listings/helpers";
import { adminRequest, application, applyAs, kybPiece, staffAccount, type Staff } from "./helpers";

const store = new MemoryObjectStore();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");

let moderator: Staff;
let individual: Staff;

beforeAll(async () => {
  resetServerEnv();
  setObjectStoreForTests(store);
  moderator = await staffAccount("moderator");
  individual = await staffAccount("individual");
});
afterAll(() => resetObjectStore());
beforeEach(() => resetRateLimiters());

/** A verified-looking application of `owner` listing `pieces`, each with its bytes in the private bucket. */
async function shop(owner: Member, pieces: { id: string; bytes: Buffer; type: string }[]): Promise<string> {
  for (const piece of pieces) store.seed("private", `kyb/${owner.uid}/${piece.id}`, piece.bytes, { contentType: piece.type });
  const applied = await applyAs(owner, application(pieces.map((piece) => piece.id)));
  expect(applied.status).toBe(201);
  return applied.body.proId;
}

const get = (proId: string, pieceId: string, staff: Staff, options: Parameters<typeof adminRequest>[5] = {}) =>
  adminRequest(view as Handler, "GET", `/kybc/${proId}/${pieceId}`, staff, undefined, { ...options, params: { proId, pieceId } });

async function viewsOf(proId: string): Promise<string[]> {
  const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", proId).where("action", "==", "pro.kybc.view").get();
  return audits.docs.map((doc) => doc.get("reason") as string);
}

describe("GET /kybc/{proId}/{pieceId}", () => {
  it("streams an image inline to a moderator, journaled, never cached", async () => {
    const owner = await member({ phone: freshPhone() });
    const pieceId = await kybPiece(owner);
    const proId = await shop(owner, [{ id: pieceId, bytes: JPEG, type: "image/jpeg" }]);

    const response = await get(proId, pieceId, moderator);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(JPEG)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(JPEG.byteLength));
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await viewsOf(proId)).toEqual([`piece ${pieceId}`]);
  });

  it("downloads a PDF as an attachment", async () => {
    const owner = await member({ phone: freshPhone() });
    const pieceId = await kybPiece(owner, { declaredType: "application/pdf" });
    const proId = await shop(owner, [{ id: pieceId, bytes: PDF, type: "application/pdf" }]);
    const response = await get(proId, pieceId, moderator);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="kybc-${proId}-${pieceId}.pdf"`);
  });

  it("is for staff on the admin host with a matching Access identity", async () => {
    const owner = await member({ phone: freshPhone() });
    const pieceId = await kybPiece(owner);
    const proId = await shop(owner, [{ id: pieceId, bytes: JPEG, type: "image/jpeg" }]);
    expect((await get(proId, pieceId, moderator, { host: "localhost:3000" })).status).toBe(404);
    expect((await get(proId, pieceId, moderator, { anonymous: true })).status).toBe(401);
    expect((await get(proId, pieceId, individual)).status).toBe(403);
    expect((await get(proId, pieceId, moderator, { accessEmail: "someone-else@staff.test" })).status).toBe(403);
    expect(await viewsOf(proId)).toEqual([]);
  });

  it("answers 404 for a piece the application does not list, a listed photo, a listed piece of someone else, or a missing object", async () => {
    const owner = await member({ phone: freshPhone() });
    const other = await member({ phone: freshPhone() });
    const listed = await kybPiece(owner);
    const unlisted = await kybPiece(owner);
    const photo = await kybPiece(owner, { purpose: "listing" });
    const foreign = await kybPiece(other);
    store.seed("private", `kyb/${other.uid}/${foreign}`, JPEG, { contentType: "image/jpeg" });
    const proId = await shop(owner, [{ id: listed, bytes: JPEG, type: "image/jpeg" }]);
    // The review lists what the application carries; a photo or someone else's piece can only get there by a bug.
    await proProfileRef(proId).update({ "kybc.uploadIds": [listed, photo, foreign, "missing-piece-id"] });

    expect((await get(proId, unlisted, moderator)).status).toBe(404);
    expect((await get(proId, photo, moderator)).status).toBe(404);
    expect((await get(proId, foreign, moderator)).status).toBe(404);
    expect((await get(proId, "missing-piece-id", moderator)).status).toBe(404);
    expect((await get("zzzzzzzz", listed, moderator)).status).toBe(404);
    expect(await viewsOf(proId)).toEqual([]);

    store.clear();
    expect((await get(proId, listed, moderator)).status).toBe(404);
  });
});
