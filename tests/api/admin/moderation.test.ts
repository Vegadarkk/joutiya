import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Moderation queue of the back office (design D8/D9) against the Firebase emulators: admin host
// only, moderators and admins only (Access identity = staff e-mail, CSRF and Origin on the
// decision), approve / reject of a listing held by the pre-moderation, the decision record
// (art. 17 DSA), the audit log, the search outbox and the seller mails (captured).

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { GET as getQueue } from "@/app/api/admin/moderation/route";
import { GET as getReview, POST as postDecision } from "@/app/api/admin/moderation/[id]/route";
import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing } from "@/lib/db/repositories/listings";
import { getModerationDecision } from "@/lib/db/repositories/moderation-decisions";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims, type Role } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { HttpError } from "@/lib/http/errors";
import { getLegalConfig } from "@/lib/legal/config";
import type { ModerationQueueResponse, ModerationReview } from "@/lib/listings/moderation-actions";
import { sendMail } from "@/lib/mail";
import { REJECT_REASONS, type ModerationDecisionResponse } from "@/lib/moderation/decisions";
import * as limiter from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { expectedOrigin } from "@/lib/security/origin";
import { capturedMails, lastMail } from "../auth/helpers";
import { DAY_MS, api, attachPhoto, member, readyPatch, seedReadyUpload, type ErrorBody, type Handler, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

const sendMailMock = vi.mocked(sendMail);
const run = Date.now().toString(36);
let counter = 0;

let ADMIN_ORIGIN = "";
let ADMIN_HOST = "";
let PUBLIC_HOST = "";

interface Staff {
  uid: string;
  email: string;
  session: string;
  csrf: string;
}

/** An account with `role` claims and a server-minted session (staff login is covered by staff.test.ts). */
async function account(role: Role): Promise<Staff> {
  counter += 1;
  const email = `mod-${run}-${counter}@staff.test`;
  const record = await auth().createUser({ email, emailVerified: true, displayName: `Staff ${counter}`, password: ["Porte", "Bleue", "2026"].join("-") });
  await setClaims(record.uid, { role, v: 2 });
  const minted = await createSessionForUid(record.uid);
  return { uid: record.uid, email, session: minted.cookie, csrf: csrfToken(minted.cookie) };
}

interface AdminCall {
  staff?: Staff;
  host?: string;
  /** null: no Origin header. */
  origin?: string | null;
  /** Access identity; defaults to the staff e-mail. */
  access?: string;
  /** false: no X-CSRF-Token header. */
  csrf?: boolean;
  body?: unknown;
}

async function admin<T>(handler: Handler, method: "GET" | "POST", path: string, options: AdminCall = {}): Promise<{ status: number; body: T }> {
  const host = options.host ?? ADMIN_HOST;
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": "10.77.0.1" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ADMIN_ORIGIN);
  const access = options.access ?? options.staff?.email;
  if (access) headers.set("x-dev-access-email", access);
  if (options.staff) headers.set("cookie", `__Host-session=${options.staff.session}`);
  if (options.staff && options.csrf !== false) headers.set("x-csrf-token", options.staff.csrf);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const id = /^\/api\/admin\/moderation\/([^/?]+)/.exec(path)?.[1];
  const request = new NextRequest(`http://${host}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const response = await handler(request, { params: Promise.resolve(id ? { id } : {}) });
  return { status: response.status, body: (await response.json()) as T };
}

const code = (body: unknown) => (body as ErrorBody).error.code;

/** A complete listing with two ready photos whose title trips the soft prohibited rule: held in pending_review. */
async function heldListing(owner: Member, title = "Réplique de vélo de course vintage"): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ title }) })).status).toBe(200);
  const first = await seedReadyUpload(owner, id);
  const second = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [first] } })).status).toBe(200);
  await attachPhoto(id, second);
  const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
  expect(result.body.status).toBe("pending_review");
  return id;
}

async function auditOf(listingId: string): Promise<Record<string, unknown>[]> {
  const snapshot = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", listingId).get();
  return snapshot.docs.map((doc) => doc.data());
}

const decision = (staff: Staff, id: string, body: unknown, options: AdminCall = {}) =>
  admin<ModerationDecisionResponse & ErrorBody>(postDecision, "POST", `/api/admin/moderation/${id}`, { staff, body, ...options });

let moderator: Staff;
let adminStaff: Staff;
let individual: Staff;
let owner: Member;

beforeAll(async () => {
  resetServerEnv();
  ADMIN_ORIGIN = expectedOrigin("admin");
  ADMIN_HOST = new URL(ADMIN_ORIGIN).host;
  PUBLIC_HOST = new URL(expectedOrigin("public")).host;
  moderator = await account("moderator");
  adminStaff = await account("admin");
  individual = await account("individual");
  owner = await member({ displayName: "Nadia Vendeuse" });
});

beforeEach(() => {
  limiter.resetRateLimiters();
  sendMailMock.mockClear();
});

describe("access", () => {
  it("answers 404 on the public host, 401 without a session, 403 for a member or a foreign Access identity", async () => {
    const id = await heldListing(owner);
    const path = `/api/admin/moderation/${id}`;
    const body = { action: "approve", version: 1 };
    for (const [handler, method, target] of [
      [getQueue, "GET", "/api/admin/moderation"],
      [getReview, "GET", path],
      [postDecision, "POST", path],
    ] as const) {
      expect((await admin(handler, method, target, { staff: moderator, host: PUBLIC_HOST, origin: expectedOrigin("public"), ...(method === "POST" ? { body } : {}) })).status, `${method} ${target} public host`).toBe(404);
      expect((await admin(handler, method, target, { access: moderator.email, ...(method === "POST" ? { body } : {}) })).status, `${method} ${target} no session`).toBe(401);
      expect((await admin(handler, method, target, { staff: individual, ...(method === "POST" ? { body } : {}) })).status, `${method} ${target} member`).toBe(403);
      expect((await admin(handler, method, target, { staff: moderator, access: adminStaff.email, ...(method === "POST" ? { body } : {}) })).status, `${method} ${target} Access mismatch`).toBe(403);
    }
    expect((await getListing(id))?.status).toBe("pending_review");
  });

  it("lets moderators and admins read the queue and the review", async () => {
    const id = await heldListing(owner);
    for (const staff of [moderator, adminStaff]) {
      expect((await admin(getQueue, "GET", "/api/admin/moderation", { staff })).status).toBe(200);
      expect((await admin(getReview, "GET", `/api/admin/moderation/${id}`, { staff })).status).toBe(200);
    }
  });

  it("refuses a decision without Origin or CSRF token (403), before touching the listing", async () => {
    const id = await heldListing(owner);
    const version = (await getListing(id))!.version;
    const noOrigin = await decision(moderator, id, { action: "approve", version }, { origin: null });
    expect(noOrigin.status).toBe(403);
    expect(code(noOrigin.body)).toBe("origin");
    const foreign = await decision(moderator, id, { action: "approve", version }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const noCsrf = await decision(moderator, id, { action: "approve", version }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(code(noCsrf.body)).toBe("csrf");
    expect((await getListing(id))?.status).toBe("pending_review");
  });

  it("rate limits decisions per staff account (429), closed policy", async () => {
    const id = await heldListing(owner);
    vi.mocked(limiter.enforceLimit).mockRejectedValueOnce(new HttpError(429, "rate_limited", "too many decisions"));
    const limited = await decision(moderator, id, { action: "approve", version: (await getListing(id))!.version });
    expect(limited.status).toBe(429);
    expect(vi.mocked(limiter.enforceLimit)).toHaveBeenCalledWith(expect.any(String), moderator.uid);
    expect((await getListing(id))?.status).toBe("pending_review");
  });
});

describe("queue and review", () => {
  it("lists held listings oldest first, with flags, score, photo and seller", async () => {
    const older = await heldListing(owner, "Réplique de vélo de course ancien");
    const newer = await heldListing(owner, "Réplique de vélo de course récent");
    const result = await admin<ModerationQueueResponse>(getQueue, "GET", "/api/admin/moderation", { staff: moderator });
    const ids = result.body.items.map((item) => item.id);
    expect(ids).toContain(older);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
    const waiting = result.body.items.map((item) => item.waitingSince);
    expect([...waiting].sort()).toEqual(waiting);
    const item = result.body.items.find((entry) => entry.id === older)!;
    // The same seller posts many listings here: volume and duplicate-text flags join in.
    expect(item.flags).toContain("prohibited_soft");
    expect(item).toMatchObject({ photoCount: 2, seller: { displayName: "Nadia Vendeuse", type: "individual" } });
    expect(item.photo?.id).toBeTruthy();
  });

  it("returns the review: listing, photos with their checks, the hold decision, a fresh screening and seller facts", async () => {
    const id = await heldListing(owner);
    const result = await admin<{ review: ModerationReview }>(getReview, "GET", `/api/admin/moderation/${id}`, { staff: moderator });
    expect(result.status).toBe(200);
    const { review } = result.body;
    expect(review.listing).toMatchObject({ id, status: "pending_review", title: "Réplique de vélo de course vintage" });
    expect(review.listing.photos).toHaveLength(2);
    expect(review.listing.photos[0]).toMatchObject({ uploadStatus: "ready", checks: { nsfw: 0.01, faces: 0 } });
    expect(review.moderation.flags).toContain("prohibited_soft");
    expect(review.moderation).toMatchObject({ state: "needs_review", lastDecision: { action: "restrict_visibility", automated: true } });
    expect(review.screening?.flags).toContain("prohibited_soft");
    expect(review.seller).toMatchObject({ displayName: "Nadia Vendeuse", status: "active", emailVerified: true, phoneVerified: false });
    expect(review.seller.accountAgeDays).toBeGreaterThanOrEqual(29);
    expect(review.seller.decisions.length).toBeGreaterThan(0);
    // No private data of the seller in the review.
    expect(JSON.stringify(review)).not.toContain(owner.email);
  });

  it("answers 404 for an unknown listing, a malformed id and a draft", async () => {
    expect((await admin(getReview, "GET", "/api/admin/moderation/zzzz2345", { staff: moderator })).status).toBe(404);
    expect((await admin(getReview, "GET", "/api/admin/moderation/..%2Fusers", { staff: moderator })).status).toBe(404);
    const draft = (await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} })).body.id;
    expect((await admin(getReview, "GET", `/api/admin/moderation/${draft}`, { staff: moderator })).status).toBe(404);
    expect((await decision(moderator, "zzzz2345", { action: "approve", version: 1 })).status).toBe(404);
    expect((await decision(moderator, "..%2Fusers", { action: "approve", version: 1 })).status).toBe(404);
  });
});

describe("decisions", () => {
  it("approves: published and dated, human_ok, decision restore, audit, search upsert, listingApproved mail", async () => {
    const id = await heldListing(owner);
    const before = (await getListing(id))!;
    const started = Date.now();
    const result = await decision(moderator, id, { action: "approve", version: before.version, note: "Vélo d'occasion, pas une contrefaçon." });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "published", decisionId: expect.any(String) });

    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "published", version: before.version + 1, slugId: before.slugId, adsEligible: true, moderation: expect.objectContaining({ state: "human_ok", reviewedBy: moderator.uid, lastDecisionId: result.body.decisionId }) });
    expect(stored.publishedAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(stored.expiresAt!.getTime() - stored.publishedAt!.getTime()).toBe((await getLegalConfig()).listingTtlDays * DAY_MS);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: before.version + 1 });

    const record = await getModerationDecision(result.body.decisionId);
    expect(record).toMatchObject({ target: { type: "listing", id }, affectedUid: owner.uid, action: "restore", decidedBy: moderator.uid, templateId: "listingApproved", origin: "own_initiative", automation: { detection: true, decision: false }, notifiedAt: expect.any(Date) });
    expect(record?.facts).toContain("pas une contrefaçon");

    const logs = await auditOf(id);
    expect(logs.find((log) => log["action"] === "listing.approve")).toMatchObject({ actorUid: moderator.uid, actorRole: "moderator", automated: false, reason: `decision ${result.body.decisionId}` });

    const mail = lastMail(sendMail, "listingApproved", owner.email);
    expect(mail).toMatchObject({ locale: "fr", priority: "transactional", data: { displayName: "Nadia Vendeuse", title: "Réplique de vélo de course vintage", url: `http://localhost:3000/fr/annonce/${stored.slugId}`, expiresAt: stored.expiresAt!.toISOString() } });
    expect(mail?.idempotencyKey).toBe(`listingApproved-${id}-${before.version + 1}`);
  });

  it("rejects with a reason template: rejected, human_rejected, decision remove, statement of reasons (human, redress)", async () => {
    const id = await heldListing(owner);
    const before = (await getListing(id))!;
    const details = "Le titre annonce une réplique de marque.";
    const result = await admin<ModerationDecisionResponse>(postDecision, "POST", `/api/admin/moderation/${id}`, { staff: adminStaff, body: { action: "reject", version: before.version, reason: "counterfeit", details } });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("rejected");

    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "rejected", adsEligible: false, moderation: expect.objectContaining({ state: "human_rejected", reviewedBy: adminStaff.uid }) });
    expect(stored.publishedAt).toBeUndefined();
    const record = await getModerationDecision(result.body.decisionId);
    expect(record).toMatchObject({ action: "remove", decidedBy: adminStaff.uid, templateId: "listingRejected", automation: { detection: true, decision: false }, ground: { type: "terms", ref: REJECT_REASONS.counterfeit.ground.ref } });
    expect(record?.facts).toContain(REJECT_REASONS.counterfeit.facts.fr);
    expect(record?.facts).toContain(details);
    expect((await auditOf(id)).find((log) => log["action"] === "listing.reject")).toMatchObject({ actorUid: adminStaff.uid, actorRole: "admin", reason: `counterfeit; decision ${result.body.decisionId}` });

    const mail = lastMail(sendMail, "listingRejected", owner.email);
    expect(mail?.data).toEqual({
      displayName: "Nadia Vendeuse",
      title: "Réplique de vélo de course vintage",
      listingId: id,
      statement: { measure: "reject", facts: ["reason:counterfeit", details], ground: REJECT_REASONS.counterfeit.ground.ref, automated: false, redress: (await getLegalConfig()).dsaContactEmail },
    });
    expect(capturedMails(sendMail).some((sent) => sent.template === "listingApproved")).toBe(false);
  });

  it("validates the body: other without details, unknown reason, extra field (400)", async () => {
    const id = await heldListing(owner);
    const { version } = (await getListing(id))!;
    for (const body of [{ action: "reject", version, reason: "other" }, { action: "reject", version, reason: "ugly" }, { action: "approve", version, reviewer: "me" }, { action: "approve" }, { action: "ban", version }]) {
      const result = await decision(moderator, id, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect((await getListing(id))?.status).toBe("pending_review");
    const other = await decision(moderator, id, { action: "reject", version, reason: "other", details: "Annonce en double d'une annonce déjà publiée." });
    expect(other.status).toBe(200);
  });

  it("refuses a stale version, a second decision and a listing that is not pending (409)", async () => {
    const id = await heldListing(owner);
    const { version } = (await getListing(id))!;
    expect((await decision(moderator, id, { action: "approve", version: version - 1 })).status).toBe(409);
    expect((await decision(moderator, id, { action: "approve", version })).status).toBe(200);
    const again = await decision(adminStaff, id, { action: "reject", version: version + 1, reason: "scam" });
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe("conflict");
    expect((await getListing(id))?.status).toBe("published");
  });

  it("two moderators deciding at once: one wins, the other gets 409, one decision is recorded", async () => {
    const id = await heldListing(owner);
    const { version } = (await getListing(id))!;
    sendMailMock.mockClear();
    const results = await Promise.all([decision(moderator, id, { action: "approve", version }), decision(adminStaff, id, { action: "reject", version, reason: "scam" })]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    const stored = (await getListing(id))!;
    expect(stored.status).toBe(winner.body.status);
    expect(stored.version).toBe(version + 1);
    const decisions = await db().collection(COLLECTIONS.moderationDecisions).where("target.id", "==", id).where("decidedBy", "in", [moderator.uid, adminStaff.uid]).get();
    expect(decisions.size).toBe(1);
    expect(capturedMails(sendMail).filter((mail) => mail.template === "listingApproved" || mail.template === "listingRejected")).toHaveLength(1);
  });
});

describe("after a decision", () => {
  /** A clean complete listing, published by the owner (auto_ok). */
  async function publishedListing(seller: Member): Promise<string> {
    const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: seller, body: {} });
    const id = created.body.id;
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: readyPatch() })).status).toBe(200);
    const photo = await seedReadyUpload(seller, id);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: { photos: [photo] } })).status).toBe(200);
    const result = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: seller, body: { acceptRules: true } });
    expect(result.body.status).toBe("published");
    return id;
  }

  it("holds again a listing a moderator rejected, once reopened and cleaned (rejection counted)", async () => {
    const seller = await member();
    const id = await heldListing(seller);
    const rejected = await decision(moderator, id, { action: "reject", version: (await getListing(id))!.version, reason: "counterfeit" });
    expect(rejected.status).toBe(200);

    // The owner edits it (back to a draft) with a clean title the automated screen would publish.
    const reopened = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: { title: "Vélo de course vintage d'origine" } });
    expect(reopened.status).toBe(200);
    expect(reopened.body.listing.status).toBe("draft");
    const republished = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: seller, body: { acceptRules: true } });
    expect(republished.status).toBe(200);
    expect(republished.body.status).toBe("pending_review");

    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "pending_review", adsEligible: false, moderation: expect.objectContaining({ state: "needs_review" }) });
    expect(stored.moderation.score).toBeGreaterThanOrEqual(10);
    expect(stored.publishedAt).toBeUndefined();
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete" });
    const hold = await getModerationDecision(stored.moderation.lastDecisionId!);
    expect(hold).toMatchObject({ action: "restrict_visibility", decidedBy: "system", automation: { detection: true, decision: true } });
    expect(hold?.facts).toContain("previously rejected by a moderator");

    // A second approval publishes it, dated like a first publication.
    const started = Date.now();
    const approved = await decision(moderator, id, { action: "approve", version: stored.version });
    expect(approved.status).toBe(200);
    expect((await getListing(id))!.publishedAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
  });

  it("approves a held edit of a published listing without touching its dates or rank", async () => {
    const seller = await member();
    const id = await publishedListing(seller);
    const live = (await getListing(id))!;
    const held = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: { title: "Réplique de vélo de course vintage" } });
    expect(held.body.listing.status).toBe("pending_review");
    const pending = (await getListing(id))!;

    const result = await decision(moderator, id, { action: "approve", version: pending.version });
    expect(result.status).toBe(200);
    const stored = (await getListing(id))!;
    expect(stored).toMatchObject({ status: "published", sortSource: live.sortSource, moderation: expect.objectContaining({ state: "human_ok" }) });
    expect(stored.publishedAt).toEqual(live.publishedAt);
    expect(stored.sortAt).toEqual(live.sortAt);
    expect(stored.expiresAt).toEqual(live.expiresAt);
    expect(stored.purgeAt).toEqual(live.purgeAt);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: stored.version });
    expect(lastMail(sendMail, "listingApproved", seller.email)?.data.expiresAt).toBe(live.expiresAt!.toISOString());
  });

  it("gives a fresh lifetime when the expiry passed while the edit waited", async () => {
    const seller = await member();
    const id = await publishedListing(seller);
    const live = (await getListing(id))!;
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: seller, body: { title: "Réplique de vélo de course vintage" } })).body.listing.status).toBe("pending_review");
    await db().collection(COLLECTIONS.listings).doc(id).update({ expiresAt: new Date(Date.now() - DAY_MS) });
    const pending = (await getListing(id))!;
    const started = Date.now();
    expect((await decision(moderator, id, { action: "approve", version: pending.version })).status).toBe(200);
    const stored = (await getListing(id))!;
    expect(stored.publishedAt).toEqual(live.publishedAt);
    expect(stored.sortAt).toEqual(live.sortAt);
    expect(stored.expiresAt!.getTime() - started).toBeGreaterThan(59 * DAY_MS);
  });
});
