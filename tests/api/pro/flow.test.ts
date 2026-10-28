import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClaimsModule from "@/lib/firebase/claims";

// Pro accounts (phase 7 design §4) against the Firebase emulators: the application (eligibility,
// pieces, one shop per account), GET /api/pro/me in every state, the back-office KYBC queue and
// decision (verify with the launch offer, reject with a reason, resubmission), the claims and
// account changes, the retag of the owner's listings, the Pro quotas at publication, and the
// rerun of the post-commit effects when Firebase Auth failed once; while the WhatsApp check is
// unavailable, the number declared with the application and the moderator's call that verifies it.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));
vi.mock("@/lib/firebase/claims", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaimsModule>();
  return { ...actual, updateClaims: vi.fn(actual.updateClaims) };
});

import { GET as getQueue } from "@/app/api/admin/pros/route";
import { GET as getReview, POST as postDecision } from "@/app/api/admin/pros/[proId]/route";
import { POST as postPhoneCheck } from "@/app/api/admin/pros/[proId]/phone/route";
import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { GET as getMe } from "@/app/api/pro/me/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { ProDecisionResponse, ProMeResponse, ProPhoneCheckResponse, ProQueueResponse, ProReview } from "@/lib/contracts/pro";
import { getListing } from "@/lib/db/repositories/listings";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { getClaims, updateClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { KYBC_NOTICE_VERSION } from "@/lib/pro/kybc";
import { csrfToken } from "@/lib/security/csrf";
import { lastMail } from "../auth/helpers";
import { api, attachPhoto, freshPhone, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "../listings/helpers";
import { admin, application, applyAs, code, kybPiece, staffAccount, withWhatsApp, type Staff } from "./helpers";

const me = (owner: Member) => api<ProMeResponse>(getMe, "GET", "/api/pro/me", { member: owner });

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

async function auditActions(proId: string): Promise<string[]> {
  const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", proId).get();
  return audits.docs.map((doc) => doc.get("action") as string);
}

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  moderator = await staffAccount("moderator");
});

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
  vi.mocked(updateClaims).mockClear();
});

describe("POST /api/pro/apply", () => {
  it("needs a phone verified beforehand while the WhatsApp check works", async () => {
    const owner = await member();
    const piece = await kybPiece(owner);
    const result = await withWhatsApp(() => applyAs(owner, application([piece], { phone: freshPhone() })));
    expect(result.status).toBe(403);
    expect(code(result.body)).toBe("phone_required");
  });

  it("without the WhatsApp check, takes the Moroccan mobile a moderator will call", async () => {
    const owner = await member();
    const piece = await kybPiece(owner);
    const missing = await applyAs(owner, application([piece]));
    expect(missing.status).toBe(400);
    expect(code(missing.body)).toBe("phone_required");
    const landline = await applyAs(owner, application([piece], { phone: "05 22 12 34 56" }));
    expect(code(landline.body)).toBe("phone_not_mobile");
    const phone = freshPhone();
    const result = await applyAs(owner, application([piece], { phone: `0${phone.slice(4)}` }));
    expect(result.status).toBe(201);
    expect((await getProProfile(result.body.proId))?.kybc.phoneToCheck).toBe(phone);
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

  it("creates one pending shop per account and records the notice shown", async () => {
    const owner = await member({ phone: freshPhone() });
    const piece = await kybPiece(owner);
    const result = await applyAs(owner, application([piece]));
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("pending_verification");
    const profile = await getProProfile(result.body.proId);
    expect(profile).toMatchObject({ ownerUid: owner.uid, lifecycle: "pending_verification", plan: "none", legal: { ice: "001234567000089" } });
    expect(profile?.kybc).toMatchObject({ status: "submitted", iceFormatOk: true, uploadIds: [piece], noticeVersion: KYBC_NOTICE_VERSION });
    expect(profile?.purgeAt).toBeUndefined();
    expect((await getUserRecord(owner.uid))?.proId).toBe(result.body.proId);
    expect((await getUserRecord(owner.uid))?.type).toBe("individual");

    const again = await applyAs(owner, application([piece]));
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe("pro_application_exists");
  });
});

describe("GET /api/pro/me", () => {
  it("shows the switches and the eligibility of an account without a shop", async () => {
    const owner = await member();
    const result = await me(owner);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ signupOpen: true, salesOpen: false, phoneVerification: "call", launchOffer: { noticeDays: 30 }, eligibility: { emailVerified: true, phoneVerified: false, accountActive: true }, shop: null });
  });

  it("follows the application from pending to verified, with the storefront and the launch offer", async () => {
    const owner = await member({ phone: freshPhone() });
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const proId = applied.body.proId;
    const pending = await me(owner);
    expect(pending.body.shop).toMatchObject({ proId, name: "Atlas Vélos", lifecycle: "pending_verification", kybcStatus: "submitted", plan: "none", storefront: null, launchOffer: null, activeListings: 0, rejectReason: null });
    expect(pending.body.shop?.submittedAt).toBe((await getProProfile(proId))!.kybc.submittedAt!.toISOString());

    const decided = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt: pending.body.shop!.submittedAt });
    expect(decided.status).toBe(200);
    await signInAgain(owner);
    const verified = await me(owner);
    expect(verified.body.shop).toMatchObject({ lifecycle: "verified", kybcStatus: "verified", plan: "essentiel", planSource: "launch_offer", launchOffer: { noticeDays: 30 }, storefront: `${pending.body.shop!.slug}-${proId}` });
    expect(verified.body.shop?.quotas).toEqual(expect.objectContaining({ photosPerListing: expect.any(Number) }));
  });

  it("carries the moderator's reason after a rejection", async () => {
    const owner = await member({ phone: freshPhone() });
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const submittedAt = (await getProProfile(applied.body.proId))!.kybc.submittedAt!.toISOString();
    const reason = "Le numéro d'auto-entrepreneur est illisible.";
    await admin(postDecision, "POST", `/api/admin/pros/${applied.body.proId}`, moderator, { action: "reject", reason, submittedAt });
    const rejected = await me(owner);
    expect(rejected.body.shop).toMatchObject({ lifecycle: "rejected", kybcStatus: "rejected", rejectReason: reason, storefront: null });
  });

  it("is for signed-in members only", async () => {
    const result = await api<ErrorBody>(getMe, "GET", "/api/pro/me");
    expect(result.status).toBe(401);
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
    expect(review.body.review.effectsPending).toBe(false);
    const submittedAt = review.body.review.kybc.submittedAt!;

    const decided = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ proId, lifecycle: "verified", effectsPending: false });
    expect(decided.body.retagged).toBeGreaterThanOrEqual(1);

    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", kybc: { status: "verified" } });
    expect((await getProProfile(proId))?.effectsPendingSince).toBeUndefined();
    expect((await getUserRecord(owner.uid))?.type).toBe("pro");
    expect(await getClaims(owner.uid)).toMatchObject({ role: "pro", proId, proRole: "owner" });
    expect(await getListing(listingId)).toMatchObject({ sellerType: "pro", proId });
    expect(lastMail(sendMail, "proApproved", owner.email)?.data).toMatchObject({ shopName: "Atlas Vélos", launchOffer: true, noticeDays: 30 });
    expect(await auditActions(proId)).toContain("pro.verify");

    // Verified, claims in place, nothing pending: a second verify is a decided application.
    const twice = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(twice.status).toBe(409);
    expect(updateClaims).toHaveBeenCalledTimes(1);

    // Signed in again, the shop publishes as a Pro under the Essentiel quotas.
    await signInAgain(owner);
    const second = await publishedListing(owner);
    expect(await getListing(second)).toMatchObject({ sellerType: "pro", proId });
  });

  it("commits the verification even when Firebase Auth fails, marks the effects pending, and the same verify reruns them", async () => {
    const owner = await member({ phone: freshPhone() });
    const listingId = await publishedListing(owner);
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const proId = applied.body.proId;
    const submittedAt = (await getProProfile(proId))!.kybc.submittedAt!.toISOString();
    vi.mocked(updateClaims).mockRejectedValueOnce(new Error("auth unavailable"));

    const decided = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "directinfo", submittedAt });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ lifecycle: "verified", effectsPending: true });
    // The profile and the account are verified; the retag ran (it does not depend on Auth); the trace and the mail exist.
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "verified", plan: "essentiel", effectsPendingSince: expect.any(Date) });
    expect((await getUserRecord(owner.uid))?.type).toBe("pro");
    expect((await getClaims(owner.uid)).role).toBe("individual");
    expect(await getListing(listingId)).toMatchObject({ sellerType: "pro", proId });
    expect(await auditActions(proId)).toContain("pro.verify");
    expect(lastMail(sendMail, "proApproved", owner.email)).toBeDefined();
    const review = await admin<{ review: ProReview }>(getReview, "GET", `/api/admin/pros/${proId}`, moderator);
    expect(review.body.review.effectsPending).toBe(true);

    // The moderator verifies again: the effects rerun, the marker clears, no new mail.
    const rerun = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "directinfo", submittedAt });
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ lifecycle: "verified", effectsPending: false, retagged: 0 });
    expect(await getClaims(owner.uid)).toMatchObject({ role: "pro", proId, proRole: "owner" });
    expect((await getProProfile(proId))?.effectsPendingSince).toBeUndefined();
    expect(await auditActions(proId)).toContain("pro.verify.rerun");
    expect(vi.mocked(sendMail).mock.calls.filter(([mail]) => (mail as { to: string; template: string }).to === owner.email && (mail as { template: string }).template === "proApproved")).toHaveLength(1);

    const third = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "directinfo", submittedAt });
    expect(third.status).toBe(409);
  });

  it("rejects with the reason and a purge date, then accepts a resubmission", async () => {
    const owner = await member({ phone: freshPhone() });
    const applied = await applyAs(owner, application([await kybPiece(owner)]));
    const proId = applied.body.proId;
    const submittedAt = (await getProProfile(proId))!.kybc.submittedAt!.toISOString();
    const reason = "L'ICE ne correspond pas au registre du commerce.";

    const stale = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "reject", reason, submittedAt: new Date(Date.parse(submittedAt) - 1000).toISOString() });
    expect(stale.status).toBe(409);

    const rejected = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "reject", reason, submittedAt });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ lifecycle: "rejected", retagged: 0, effectsPending: false });
    const profile = await getProProfile(proId);
    expect(profile).toMatchObject({ lifecycle: "rejected", kybc: { status: "rejected", rejectReason: reason } });
    expect(profile!.purgeAt!.getTime() - Date.parse(submittedAt)).toBeGreaterThan(180 * 24 * 3_600_000);
    expect((await getClaims(owner.uid)).role).toBe("individual");
    expect(lastMail(sendMail, "proRejected", owner.email)?.data).toMatchObject({ reason });

    const again = await applyAs(owner, application([await kybPiece(owner)], { name: "Atlas Vélos SARL" }));
    expect(again.status).toBe(201);
    expect(again.body.proId).toBe(proId);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "pending_verification", name: "Atlas Vélos SARL", kybc: { status: "submitted" } });
    expect((await getProProfile(proId))?.purgeAt).toBeUndefined();
  });

  it("is for staff on the admin host only", async () => {
    const individual = await staffAccount("individual");
    const denied = await admin<ErrorBody>(getQueue, "GET", "/api/admin/pros", individual);
    expect(denied.status).toBe(403);
    expect(code(denied.body)).toBe("forbidden");
  });
});

describe("back-office phone check by call", () => {
  const check = (proId: string, body: unknown, staff = moderator) => admin<ProPhoneCheckResponse & ErrorBody>(postPhoneCheck, "POST", `/api/admin/pros/${proId}/phone`, staff, body);

  async function callApplicant(phone = freshPhone()) {
    const owner = await member();
    const applied = await applyAs(owner, application([await kybPiece(owner)], { phone }));
    expect(applied.status).toBe(201);
    return { owner, proId: applied.body.proId, phone };
  }

  it("records each call; verified marks the number on the account, then the verification goes through", async () => {
    const { owner, proId, phone } = await callApplicant();
    const review = await admin<{ review: ProReview }>(getReview, "GET", `/api/admin/pros/${proId}`, moderator);
    expect(review.body.review.owner).toMatchObject({ phoneVerified: false, phoneToCheck: phone });
    expect(review.body.review.kybc.phoneCheck).toBeNull();
    const submittedAt = review.body.review.kybc.submittedAt!;
    const early = await admin<ErrorBody>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(early.status).toBe(409);
    expect(code(early.body)).toBe("phone_unverified");

    const unreachable = await check(proId, { outcome: "unreachable", note: "Messagerie, rappel demain" });
    expect(unreachable.body).toEqual({ proId, outcome: "unreachable", phoneVerified: false, transferred: false });
    expect((await getUserRecord(owner.uid))?.badges.phoneVerified).toBe(false);

    const verified = await check(proId, { outcome: "verified" });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ proId, outcome: "verified", phoneVerified: true, transferred: false });
    expect((await getUserRecord(owner.uid))?.badges.phoneVerified).toBe(true);
    expect((await getUserPrivate(owner.uid))?.phoneE164).toBe(phone);
    const profile = await getProProfile(proId);
    expect(profile?.kybc.phoneToCheck).toBeUndefined();
    expect(profile?.kybc.phoneCheck).toMatchObject({ by: moderator.uid, outcome: "verified", phone });
    expect(vi.mocked(sendMail).mock.calls.filter(([mail]) => mail.template === "phoneVerified")).toHaveLength(1);
    expect((await auditActions(proId)).filter((action) => action === "pro.phone.check")).toHaveLength(2);
    expect(await auditActions(owner.uid)).toContain("phone.verified");
    expect((await check(proId, { outcome: "verified" })).status).toBe(409);

    const decided = await admin<ProDecisionResponse>(postDecision, "POST", `/api/admin/pros/${proId}`, moderator, { action: "verify", registrySource: "ompic", submittedAt });
    expect(decided.status).toBe(200);
    expect((await check(proId, { outcome: "unreachable" })).status).toBe(409);
  });

  it("takes the number corrected on the call, away from the account that held it", async () => {
    const holder = await member({ phone: freshPhone() });
    const held = (await getUserPrivate(holder.uid))!.phoneE164!;
    const { owner, proId } = await callApplicant();
    const bad = await check(proId, { outcome: "verified", phone: "05 22 12 34 56" });
    expect(code(bad.body)).toBe("phone_not_mobile");
    const moved = await check(proId, { outcome: "verified", phone: held });
    expect(moved.body).toEqual({ proId, outcome: "verified", phoneVerified: true, transferred: true });
    expect((await getUserPrivate(owner.uid))?.phoneE164).toBe(held);
    expect((await getUserRecord(holder.uid))?.badges.phoneVerified).toBe(false);
    expect((await getUserPrivate(holder.uid))?.phoneE164).toBeUndefined();
    expect(await auditActions(holder.uid)).toContain("phone.transferred");
  });

  it("is for staff on the admin host, on an application under review", async () => {
    const { proId } = await callApplicant();
    const individual = await staffAccount("individual");
    expect((await check(proId, { outcome: "verified" }, individual)).status).toBe(403);
    expect((await check("zzzzzzzz", { outcome: "verified" })).status).toBe(404);
    expect((await check(proId, { outcome: "maybe" })).status).toBe(400);
    expect((await getProProfile(proId))?.kybc.phoneCheck).toBeUndefined();
  });
});
