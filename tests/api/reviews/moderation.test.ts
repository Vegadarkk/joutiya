import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { Timestamp } from "firebase-admin/firestore";
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import { POST as createRoute } from "@/app/api/reviews/route";
import { REVIEWS_API, type ReviewCreated } from "@/lib/contracts/reviews";
import type { DecideResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { hideReceivedReviews } from "@/lib/reviews/repository";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { adminCall, mailTo, staff, type Staff } from "../admin/decisions/helpers";
import { call, type CallResult } from "../favorites/helpers";
import { member, seedListing, send, startOk, type ErrorBody, type Member } from "../messaging/helpers";
import { report, visitor } from "../reports/helpers";

// Moderation of reviews (vitrine-avis §3) on the emulators: a review held for sensitive data goes
// to the moderators' queue as a system report; "no action" publishes it. A published review is
// reported by anyone but its author (the seller it is about included), held for the report's
// time; a removal hides it with a statement of reasons to its author, takes it out of the seller's
// average, and a restore brings it back with the restoration mail.

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT = "Échange rapide et courtois, l'article était conforme à l'annonce.";
const SENSITIVE = "Rencontre agréable, ma femme est diabétique et le vendeur a porté le colis jusqu'à la voiture.";
const EXPLANATION = "Cet avis m'insulte et ne parle pas de la vente, il raconte des choses fausses sur moi.";

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposal: async () => null });
  moderator = await staff("moderator");
});

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  vi.mocked(firstDegraded).mockResolvedValue(null);
  vi.mocked(sendMail).mockClear();
});

afterAll(() => setMessagingValkeyForTests(undefined));

function create(who: Member, body: unknown): Promise<CallResult<ReviewCreated & Partial<ErrorBody>>> {
  return call(createRoute, "POST", REVIEWS_API.create, { member: who, body });
}

function decide(target: string, templateId: string) {
  return adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target, templateId } });
}

/** A review of a fresh exchange, its window open. */
async function reviewed(text: string, rating = 4): Promise<{ buyer: Member; seller: Member; id: string; status: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id: listingId } = await seedListing(seller);
  const { cid } = await startOk(buyer, listingId);
  expect((await send(seller, cid, "Oui, toujours disponible.")).status).toBe(201);
  await db().collection(COLLECTIONS.conversations).doc(cid).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
  const created = await create(buyer, { cid, rating, text, exchangeConfirmed: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { buyer, seller, id: created.body.id, status: created.body.status };
}

/** A refusal: status and error code. */
function refused(result: { status: number; body: Partial<ErrorBody> }, status: number, code: string): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body.error?.code).toBe(code);
}

async function reviewDoc(id: string): Promise<Record<string, unknown>> {
  return (await db().collection(COLLECTIONS.reviews).doc(id).get()).data() ?? {};
}

async function openReports(id: string) {
  const snapshot = await db().collection(COLLECTIONS.reports).where("target.type", "==", "review").where("target.id", "==", id).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as { id: string; source: string; reasonId: string; status: string });
}

async function ratingCount(uid: string): Promise<number> {
  return (await getUserRecord(uid))!.stats.ratingCount;
}

describe("review moderation", () => {
  it("queues a held review for a moderator, and no action publishes it", async () => {
    const { buyer, seller, id, status } = await reviewed(SENSITIVE, 2);
    expect(status).toBe("pending");
    const [queued] = await openReports(id);
    expect(queued).toMatchObject({ source: "system", reasonId: "personal_data", status: "open", target: { type: "review", id, ownerUid: buyer.uid } });
    expect(JSON.stringify(queued)).not.toContain("diabétique");
    expect((await reviewDoc(id)).legalHold).toContain(`report:${queued!.id}`);

    const decided = await decide(`review:${id}`, "review.no_action");
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    expect(await reviewDoc(id)).toMatchObject({ status: "published", legalHold: [] });
    expect(await ratingCount(seller.uid)).toBe(1);
    expect((await openReports(id))[0]).toMatchObject({ status: "dismissed" });
    // Nothing was restored (the review was never public): no restoration mail.
    expect(mailTo(sendMail, "contentRestored", buyer.email)).toBeUndefined();
    // A second decision with no open report has nothing to decide.
    refused(await decide(`review:${id}`, "review.no_action"), 409, "conflict");
  });

  it("takes a notice from the seller or a visitor, never from the author", async () => {
    const { buyer, seller, id } = await reviewed(TEXT);
    const notice = (extra: Record<string, unknown> = {}) => ({ target: { type: "review", id }, reasonId: "fake_review", explanation: EXPLANATION, goodFaith: true, ...extra });
    refused(await report(notice(), { as: buyer }), 403, "report_not_allowed");
    refused(await report({ ...notice(), reasonId: "illegal_item" }, { as: seller }), 400, "invalid_body");
    const fromSeller = await report(notice(), { as: seller });
    expect(fromSeller.status, JSON.stringify(fromSeller.body)).toBe(201);
    expect(fromSeller.body.priority).toBe("P2");
    const fromVisitor = await report(notice({ name: "Karim Visiteur", email: "karim@example.test", turnstileToken: "tok" }), { as: visitor() });
    expect(fromVisitor.status, JSON.stringify(fromVisitor.body)).toBe(201);
    expect((await reviewDoc(id)).legalHold).toEqual(expect.arrayContaining([`report:${fromSeller.body.reportId}`, `report:${fromVisitor.body.reportId}`]));
    refused(await report({ ...notice(), target: { type: "review", id: "AAAAAAAAAAAAAAAAAAAAAA" } }, { as: seller }), 422, "report_target_invalid");
  });

  it("hides a reported review with a statement of reasons, and a restore brings it back", async () => {
    const { buyer, seller, id } = await reviewed(TEXT, 1);
    expect(await ratingCount(seller.uid)).toBe(1);
    const notice = await report({ target: { type: "review", id }, reasonId: "harassment", explanation: EXPLANATION, goodFaith: true }, { as: seller });
    expect(notice.status).toBe(201);

    const removed = await decide(`review:${id}`, "review.remove.abuse");
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    const hidden = await reviewDoc(id);
    expect(hidden).toMatchObject({ status: "hidden", hiddenBy: `decision:${removed.body.decisionId}`, legalHold: [] });
    expect(hidden.purgeAt).toBeInstanceOf(Timestamp);
    expect(await ratingCount(seller.uid)).toBe(0);
    expect(mailTo(sendMail, "decisionNotice", buyer.email)?.data).toMatchObject({ targetType: "review", action: "remove", title: "Salma Vendeuse" });
    expect(mailTo(sendMail, "reportOutcome", seller.email)?.data).toMatchObject({ targetType: "review", outcome: "actioned" });
    // Hidden: no longer reportable.
    refused(await report({ target: { type: "review", id }, reasonId: "spam", explanation: EXPLANATION, goodFaith: true }, { as: seller }), 422, "report_target_invalid");

    const restored = await decide(`review:${id}`, "review.restore");
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    const shown = await reviewDoc(id);
    expect(shown.status).toBe("published");
    expect(shown).not.toHaveProperty("purgeAt");
    expect(shown).not.toHaveProperty("hiddenBy");
    expect(await ratingCount(seller.uid)).toBe(1);
    expect(mailTo(sendMail, "contentRestored", buyer.email)?.data).toMatchObject({ targetType: "review" });
  });

  it("hides the reviews a seller received when the seller's account closes", async () => {
    const { seller, id } = await reviewed(TEXT, 5);
    expect(await hideReceivedReviews(seller.uid, new Date())).toBe(1);
    const doc = await reviewDoc(id);
    expect(doc).toMatchObject({ status: "hidden", hiddenBy: "account:closed" });
    expect(doc.purgeAt).toBeInstanceOf(Timestamp);
    expect(await hideReceivedReviews(seller.uid, new Date())).toBe(0);
  });
});
