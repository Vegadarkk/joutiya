import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Photos of removed listings against the Firebase emulators: purge-quarantine moves them from the
// public media bucket to the private one (removed/listings/...) through the scan of removed
// listings (real query: status in, updatedAt range, cursor in system/purgeQuarantine), the upload
// records the new location, the R2 storage gauge sum does not move, a rerun does nothing, and the
// moderation review shows them through the staff-only route /photos/{listingId}/{photoId}/{variant}.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { GET as staffPhoto } from "@/app/admin/photos/[listingId]/[photoId]/[variant]/route";
import { POST as create } from "@/app/api/listings/route";
import { DELETE as remove, PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getUpload, readRetainedScanCursor, sumStoredBytes, writeRetainedScanCursor } from "@/lib/db/repositories/uploads";
import { resetServerEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { mediaObjectKey, retainedObjectKey } from "@/lib/media/urls";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setObjectStoreForTests } from "@/lib/storage";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { expectedOrigin } from "@/lib/security/origin";
import { purgeQuarantine, RETAINED_SCAN_LAG_MS } from "@/worker/jobs/purge-quarantine";
import { api, member, readyPatch, seedReadyUpload, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

const run = Date.now().toString(36);
let counter = 0;
let ADMIN_HOST = "";
let PUBLIC_HOST = "";
let owner: Member;
let moderator: { email: string; session: string };
let individual: { email: string; session: string };
const store = new MemoryObjectStore();

async function account(role: Role): Promise<{ email: string; session: string }> {
  counter += 1;
  const email = `photos-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, password: ["Porte", "Verte", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  return { email, session: (await createSessionForUid(record.uid)).cookie };
}

async function getPhoto(path: string, options: { staff?: { email: string; session: string }; host?: string } = {}): Promise<Response> {
  const host = options.host ?? ADMIN_HOST;
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": "10.77.0.2" });
  if (options.staff) {
    headers.set("x-dev-access-email", options.staff.email);
    headers.set("cookie", `__Host-session=${options.staff.session}`);
  }
  const [, , listingId, photoId, variant] = path.split("/");
  return staffPhoto(new NextRequest(`http://${host}${path}`, { headers }), { params: Promise.resolve({ listingId, photoId, variant }) });
}

/** A published listing with one ready photo whose variants are in the media bucket. */
async function publishedListing(title: string): Promise<{ id: string; upload: string }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ title }) })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  expect((await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).body.status).toBe("published");
  for (const variant of ["l", "s"] as const) store.seed("media", mediaObjectKey(id, upload, variant), Buffer.from(`${upload}-${variant}`), { contentType: "image/webp" });
  return { id, upload };
}

beforeAll(async () => {
  resetServerEnv();
  resetRateLimiters();
  ADMIN_HOST = new URL(expectedOrigin("admin")).host;
  PUBLIC_HOST = new URL(expectedOrigin("public")).host;
  owner = await member({ displayName: "Samira Vendeuse" });
  moderator = await account("moderator");
  individual = await account("individual");
  setObjectStoreForTests(store);
});

afterAll(() => {
  setObjectStoreForTests(undefined);
});

describe("photos of a removed listing", () => {
  it("leave the public bucket on the next purge-quarantine run, keep their bytes in the gauge, and are served to staff only", async () => {
    const { id, upload } = await publishedListing("Vélo de ville retiré puis conservé");
    const kept = await publishedListing("Vélo de ville toujours en ligne");
    expect((await api(remove, "DELETE", `/api/listings/${id}`, { member: owner })).status).toBe(204);
    const removed = (await getListing(id))!;
    expect(removed.status).toBe("removed");
    // The scan resumes just before this removal (removed listings of other test files are older).
    await writeRetainedScanCursor({ at: new Date(removed.updatedAt.getTime() - 1), id });
    const bytesBefore = await sumStoredBytes();

    // Within the scan lag the listing is not read yet; once past it, the scan moves its photo.
    const early = await purgeQuarantine(new Date(removed.updatedAt.getTime() + RETAINED_SCAN_LAG_MS - 1_000), { store });
    expect(early.failed).toBe(0);
    expect(store.has("media", mediaObjectKey(id, upload, "l"))).toBe(true);
    const now = new Date(removed.updatedAt.getTime() + RETAINED_SCAN_LAG_MS + 1_000);
    const result = await purgeQuarantine(now, { store });
    expect(result.failed).toBe(0);
    expect(result.retained).toBeGreaterThanOrEqual(1);

    for (const variant of ["l", "s"] as const) {
      expect(store.has("media", mediaObjectKey(id, upload, variant))).toBe(false);
      expect((await store.get("private", retainedObjectKey(id, upload, variant)))?.toString()).toBe(`${upload}-${variant}`);
    }
    expect(await getUpload(upload)).toMatchObject({ status: "ready", bucket: "private", finalKey: `removed/listings/${id}/${upload}`, size: 118_000 });
    // The photo stays on the listing (evidence until the purge); a live listing's photos stay public.
    expect((await getListing(id))!.photos.map((photo) => photo.id)).toEqual([upload]);
    expect(store.has("media", mediaObjectKey(kept.id, kept.upload, "l"))).toBe(true);
    expect((await getUpload(kept.upload))?.bucket).toBe("media");
    // Same bytes, other bucket: the gauge recount does not move (other than for the unattached
    // uploads of earlier test files that these runs purged).
    expect(await sumStoredBytes()).toBe(bytesBefore - early.freedBytes - result.freedBytes);
    const cursor = (await readRetainedScanCursor())!;
    expect(cursor.at.getTime()).toBeGreaterThanOrEqual(removed.updatedAt.getTime());

    // A rerun has nothing left to move for this listing.
    const calls = store.calls.length;
    expect((await purgeQuarantine(new Date(now.getTime() + 3_600_000), { store })).failed).toBe(0);
    expect(store.calls.slice(calls).filter((call) => call.key.includes(id))).toEqual([]);

    // Staff route: moderators read the private copy; nobody else does.
    const path = `/photos/${id}/${upload}/s`;
    const ok = await getPhoto(path, { staff: moderator });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/webp");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe(`${upload}-s`);
    expect((await getPhoto(path, { staff: individual })).status).toBe(403);
    expect((await getPhoto(path)).status).toBe(401);
    expect((await getPhoto(path, { staff: moderator, host: PUBLIC_HOST })).status).toBe(404);
    expect((await getPhoto(`/photos/${id}/unknownphoto0001/s`, { staff: moderator })).status).toBe(404);
    expect((await getPhoto(`/photos/${id}/${upload}/xl`, { staff: moderator })).status).toBe(404);
    // A photo still in the media bucket (listing removed within the hour) is found there.
    const live = await getPhoto(`/photos/${kept.id}/${kept.upload}/l`, { staff: moderator });
    expect(live.status).toBe(200);
  });
});
