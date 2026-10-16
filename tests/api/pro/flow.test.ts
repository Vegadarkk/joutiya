import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pro accounts (phase 7 design §4) against the Firebase emulators: the application (eligibility,
// pieces, one shop per account), the back-office KYBC queue and decision (verify with the launch
// offer, reject with a reason, resubmission), the claims and account changes, the retag of the
// owner's listings and the Pro quotas at publication.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { GET as getQueue } from "@/app/api/admin/pros/route";
import { GET as getReview, POST as postDecision } from "@/app/api/admin/pros/[proId]/route";
import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as apply } from "@/app/api/pro/apply/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { ProApplyResponse, ProDecisionResponse, ProQueueResponse, ProReview } from "@/lib/contracts/pro";
import { getListing } from "@/lib/db/repositories/listings";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { createUpload, newUploadId } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { getClaims, setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { lastMail } from "../auth/helpers";
import { DAY_MS, api, attachPhoto, freshPhone, member, readyPatch, seedReadyUpload, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

const run = Date.now().toString(36);
let counter = 0;
let ADMIN_ORIGIN = "";
let ADMIN_HOST = "";

interface Staff {
  uid: string;
  email: string;
  session: string;
  csrf: string;
}

async function staffAccount(role: Role): Promise<Staff> {
  counter += 1;
  const email = `pro-staff-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: `Staff ${counter}`, password: ["Porte", "Verte", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  const minted = await createSessionForUid(record.uid);
  return { uid: record.uid, email, session: minted.cookie, csrf: csrfToken(minted.cookie) };
}

async function admin<T>(handler: Handler, method: "GET" | "POST", path: string, staff: Staff, body?: unknown): Promise<{ status: number; body: T }> {
  const headers = new Headers({ host: ADMIN_HOST, "user-agent": "vitest", "x-forwarded-for": "10.78.0.1", origin: ADMIN_ORIGIN, "x-dev-access-email": staff.email });
  headers.set("cookie", `__Host-session=${staff.session}`);
  headers.set("x-csrf-token", staff.csrf);
  if (body !== undefined) headers.set("content-type", "application/json");
  const proId = /^\/api\/admin\/pros\/([^/?]+)/.exec(path)?.[1];
  const request = new NextRequest(`http://${ADMIN_HOST}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handler(request, { params: Promise.resolve(proId ? { proId } : {}) });
  return { status: response.status, body: (await response.json()) as T };
}

const code = (body: unknown) => (body as ErrorBody).error.code;

/** A `ready` KYBC piece of `owner` (private bucket), as the KYBC upload path leaves it. */
async function kybPiece(owner: Member, overrides: { ownerUid?: string; purpose?: "kyb" | "listing" } = {}): Promise<string> {
  const id = newUploadId();
  const now = new Date();
  await createUpload(id, {
    ownerUid: overrides.ownerUid ?? owner.uid,
    purpose: overrides.purpose ?? "kyb",
    targetId: owner.uid,
    declaredSize: 90_000,
    declaredType: "image/jpeg",
    status: "ready",
    quarantineKey: `quarantine/kyb/${id}`,
    finalKey: `kyb/${owner.uid}/${id}`,
    bucket: "private",
    size: 90_000,
    checks: {},
    purgeAt: new Date(now.getTime() + 7 * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function application(pieces: string[], overrides: Record<string, unknown> = {}) {
  return {
    name: "Atlas Vélos",
    description: "Vente et réparation de vélos.",
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "auto_entrepreneur", ice: "001 234 567 000 089", aeNumber: "998877" },
    uploadIds: pieces,
    complianceCommitment: true,
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    ...overrides,
  };
}

const applyAs = (owner: Member, body: unknown) => api<ProApplyResponse & ErrorBody>(apply, "POST", "/api/pro/apply", { member: owner, body });

async function publishedListing(owner: Member): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const first = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [first] } })).status).toBe(200);
  await attachPhoto(id, await seedReadyUpload(owner, id));
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.status).toBe(200);
  return id;
}

/** A fresh session after the claims changed (the decision revoked the old one). */
async function signInAgain(owner: Member): Promise<void> {
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
}

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  ADMIN_ORIGIN = expectedOrigin("admin");
  ADMIN_HOST = new URL(ADMIN_ORIGIN).host;
  moderator = await staffAccount("moderator");
});

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
});

describe("POST /api/pro/apply", () => {
  it("needs a verified phone", async () => {
    const owner = await member();
    const result = await applyAs(owner, application([await kybPiece(owner)]));
    expect(result.status).toBe(403);
    expect(code(result.body)).toBe("phone_required");
  });

  it("refuses pieces that are not the applicant's KYBC uploads", async () => {
    const owner = await member({ phone: freshPhone() });
    const other = await member();
    const foreign = await kybPiece(owner, { ownerUid: other.uid });
    const photo = await kybPiece(owner, { purpose: "listing" });
    for (const piece of [foreign, photo, "missing-upload-id"]) {
      const result = await applyAs(owner, application([piece]));
      expect(result.status).toBe(400);
      expect(code(result.body)).toBe("invalid_pieces");
    }
  });

  it("refuses a body without the compliance commitment", async () => {
    const owner = await member({ phone: freshPhone() });
    const result = await applyAs(owner, application([await kybPiece(owner)], { complianceCommitment: false }));
    expect(result.status).toBe(400);
  });

  it("creates one pending shop per account", async () => {
    const owner = await member({ phone: freshPhone() });
    const piece = await kybPiece(owner);
    const result = await applyAs(owner, application([piece]));
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("pending_verification");
    const profile = await getProProfile(result.body.proId);
    expect(profile).toMatchObject({ ownerUid: owner.uid, lifecycle: "pending_verification", plan: "none", legal: { ice: "001234567000089" } });
    expect(profile?.kybc).toMatchObject({ status: "submitted", iceFormatOk: true, uploadIds: [piece] });
    expect((await getUserRecord(owner.uid))?.proId).toBe(result.body.proId);
    expect((await getUserRecord(owner.uid))?.type).toBe("individual");

    const again = await applyAs(owner, application([piece]));
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe("pro_application_exists");
  });
});

describe("back-office KYBC decision", () => {
  it("verifies: Pro claims, account type, launch offer quotas, listings retagged, mail", async () => {
    const owner = await member({ phone: freshPhone() });
    const listingId = await publishedListing(owner);
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const proId = applied.body.proId;

    const queue = await admin<ProQueueResponse>(getQueue, "GET", "/api/admin/pros", moderator);
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((item) => item.proId === proId)).toBe(true);
    const review = await admin<{ review: ProReview }>(getReview, "GET", `/api/admin/pros/${proId}`, moderator);
    expect(review.status).toBe(200);
    expect(review.body.review.pieces).toHaveLength(1);
    const submittedAt = review.body.review.kybc.submittedAt!;

    const decided = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ proId, lifecycle: "verified" });
    expect(decided.body.retagged).toBeGreaterThanOrEqual(1);

    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", kybc: { status: "verified" } });
    expect((await getUserRecord(owner.uid))?.type).toBe("pro");
    expect(await getClaims(owner.uid)).toMatchObject({ role: "pro", proId, proRole: "owner" });
    expect(await getListing(listingId)).toMatchObject({ sellerType: "pro", proId });
    expect(lastMail(sendMail, "proApproved", owner.email)?.data).toMatchObject({ shopName: "Atlas Vélos", launchOffer: true, noticeDays: 30 });
    const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", proId).get();
    expect(audits.docs.map((doc) => doc.get("action"))).toContain("pro.verify");

    const twice = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(twice.status).toBe(409);

    // Signed in again, the shop publishes as a Pro under the Essentiel quotas.
    await signInAgain(owner);
    const second = await publishedListing(owner);
    expect(await getListing(second)).toMatchObject({ sellerType: "pro", proId });
  });

  it("rejects with the reason, then accepts a resubmission", async () => {
    const owner = await member({ phone: freshPhone() });
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const proId = applied.body.proId;
    const submittedAt = (await getProProfile(proId))!.kybc.submittedAt!.toISOString();
    const reason = "L'ICE ne correspond pas au registre du commerce.";

    const stale = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "reject", reason, submittedAt: new Date(Date.parse(submittedAt) - 1000).toISOString() });
    expect(stale.status).toBe(409);

    const rejected = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "reject", reason, submittedAt });
    expect(rejected.status).toBe(200);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "rejected", kybc: { status: "rejected", rejectReason: reason } });
    expect((await getClaims(owner.uid)).role).toBe("individual");
    expect(lastMail(sendMail, "proRejected", owner.email)?.data).toMatchObject({ reason });

    const again = await applyAs(owner, application([await kybPiece(owner)], { name: "Atlas Vélos SARL" }));
    expect(again.status).toBe(201);
    expect(again.body.proId).toBe(proId);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "pending_verification", name: "Atlas Vélos SARL", kybc: { status: "submitted" } });
  });

  it("is for staff on the admin host only", async () => {
    const individual = await staffAccount("individual");
    const denied = await admin<ErrorBody>(getQueue, "GET", "/api/admin/pros", individual);
    expect(denied.status).toBeGreaterThanOrEqual(401);
    expect(denied.status).toBeLessThan(500);
  });
});
