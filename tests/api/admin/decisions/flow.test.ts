import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exit criterion of phase 5 at API level (design §5, D13, D16) against the Firebase emulators: a
// member reports a listing, a moderator removes it (statement of reasons to the seller with the
// signed appeal link, outcome to the reporter), the seller appeals, the same moderator may not
// review it, another one reverses it, and the listing is published again. Every staff action is
// audited.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { POST as reviewRoute } from "@/app/api/admin/appeals/[decisionId]/route";
import { GET as queueRoute } from "@/app/api/admin/appeals/route";
import { GET as decisionRoute } from "@/app/api/admin/decisions/[id]/route";
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import { GET as myDecisionsRoute, POST as appealRoute } from "@/app/api/appeals/route";
import type { AppealQueueResponse, DecideResponse, DecisionView, MyDecisionsResponse, OpenAppealResponse, ReviewAppealResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { listingNotice, member, publishedListing, report } from "../../reports/helpers";
import { adminCall, audits, decision, listing, mailTo, publicCall, reportStatus, staff, type Staff } from "./helpers";

const requestAppealReview = vi.fn(async () => undefined);
const markAiDecision = vi.fn(async () => undefined);

let moderator: Staff;
let otherModerator: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview, markAiDecision, appealProposal: async () => null });
  moderator = await staff("moderator");
  otherModerator = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

describe("report -> decision -> notification -> appeal -> reversal", () => {
  it("runs end to end", async () => {
    const { id, seller } = await publishedListing();
    const reporter = await member({ displayName: "Karim Signale" });
    const notice = await report(listingNotice(id, "scam"), { as: reporter });
    expect(notice.status).toBe(201);
    const reportId = notice.body.reportId;
    expect((await listing(id)).moderation.openReports).toBe(1);

    // The decision: removal, the report actioned, the report hold released.
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: moderator,
      body: { target: `listing:${id}`, templateId: "listing.remove.scam", details: "Paiement par Wafacash exigé avant toute visite.", ai: { decisionId: "A".repeat(20), outcome: "confirmed" } },
    });
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({ action: "remove", reportIds: [reportId], sanctionDecisionId: null });
    const decisionId = decided.body.decisionId;
    const removed = await listing(id);
    expect(removed.status).toBe("removed");
    expect(removed.moderation).toMatchObject({ openReports: 0, lastDecisionId: decisionId, reviewedBy: moderator.uid });
    expect(removed.adsEligible).toBe(false);
    expect(removed.legalHold).not.toContain(`report:${reportId}`);
    expect((await getSearchOutbox(id))?.op).toBe("delete");
    expect(await reportStatus(reportId)).toMatchObject({ status: "actioned", outcome: "founded", decisionId });
    const stored = await decision(decisionId);
    expect(stored).toMatchObject({ action: "remove", origin: "notice", templateId: "listing.remove.scam", decidedBy: moderator.uid, aiDecisionId: "A".repeat(20), reportIds: [reportId] });
    expect(stored.facts).toContain("Wafacash");
    expect(stored.notifiedAt).toBeInstanceOf(Date);
    expect(markAiDecision).toHaveBeenCalledWith("A".repeat(20), "confirmed", moderator.uid, decisionId);
    expect(await audits("decision.remove", id)).toHaveLength(1);

    // Mails: the statement of reasons with its signed appeal link, the reporter's outcome.
    const notice1 = mailTo(sendMail, "decisionNotice", seller.email);
    expect(notice1?.data).toMatchObject({ decisionId, action: "remove", targetType: "listing", source: "notice", details: "Paiement par Wafacash exigé avant toute visite." });
    expect(notice1?.data.appealToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const outcome = mailTo(sendMail, "reportOutcome", reporter.email);
    expect(outcome?.data).toMatchObject({ reportId, outcome: "actioned", action: "remove", decisionId });

    // Nothing left to decide: a second removal answers 409.
    const again = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.remove.scam" } });
    expect(again.status).toBe(409);

    // The seller sees the decision and appeals it.
    const mine = await publicCall<MyDecisionsResponse>(myDecisionsRoute, "GET", "/api/appeals", { as: seller });
    expect(mine.status).toBe(200);
    expect(mine.body.items.find((item) => item.decisionId === decisionId)).toMatchObject({
      appealable: true,
      by: "affected",
      appeal: null,
      ground: { type: "terms", ref: expect.any(String) as string },
      details: "Paiement par Wafacash exigé avant toute visite.",
    });
    const appeal = await publicCall<OpenAppealResponse>(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId, text: "Je n'ai jamais demandé de paiement à l'avance." } });
    expect(appeal.status).toBe(201);
    expect(appeal.body).toMatchObject({ decisionId, by: "affected", status: "open" });
    expect(mailTo(sendMail, "appealReceived", seller.email)?.data).toMatchObject({ decisionId, slaDays: 14 });
    expect(requestAppealReview).toHaveBeenCalledWith(decisionId);
    const twice = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId, text: "Je conteste encore cette décision." } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("appeal_exists");

    // The queue shows it; the deciding moderator cannot review it.
    const queue = await adminCall<AppealQueueResponse>(queueRoute, "GET", "/api/admin/appeals", { as: moderator });
    expect(queue.body.items.find((item) => item.decisionId === decisionId)).toMatchObject({ reviewable: false, by: "affected", overdue: false });
    const same = await adminCall(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, { as: moderator, params: { decisionId }, body: { outcome: "reversed", note: "Je reviens sur ma décision." } });
    expect(same.status).toBe(403);
    expect(same.body.error.code).toBe("same_reviewer");

    // Another moderator reverses it: a new decision restores the listing, linked both ways.
    const reviewed = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, {
      as: otherModerator,
      params: { decisionId },
      body: { outcome: "reversed", note: "Les messages ne montrent aucune demande d'avance." },
    });
    expect(reviewed.status).toBe(200);
    const outcomeDecisionId = reviewed.body.outcomeDecisionId as string;
    expect(outcomeDecisionId).toMatch(/^[A-Za-z0-9]{20}$/);
    const restored = await listing(id);
    expect(restored.status).toBe("published");
    expect(restored.moderation.lastDecisionId).toBe(outcomeDecisionId);
    expect(restored.adsEligible).toBe(true);
    expect((await getSearchOutbox(id))?.op).toBe("upsert");

    const original = await adminCall<{ decision: DecisionView }>(decisionRoute, "GET", `/api/admin/decisions/${decisionId}`, { as: otherModerator, params: { id: decisionId } });
    expect(original.body.decision).toMatchObject({ supersededBy: outcomeDecisionId, appeal: { status: "reversed", reviewer: otherModerator.uid, outcomeDecisionId } });
    expect(await decision(outcomeDecisionId)).toMatchObject({ action: "restore", templateId: "appeal.reversed", supersedes: decisionId, decidedBy: otherModerator.uid });
    expect(mailTo(sendMail, "appealOutcome", seller.email)?.data).toMatchObject({ decisionId, outcome: "reversed", by: "affected" });
    expect(await audits("appeal.reversed", decisionId)).toHaveLength(1);
    expect(await audits("decision.restore", id)).toHaveLength(1);

    // A superseded decision cannot be appealed again.
    const closed = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId, text: "Une nouvelle contestation." } });
    expect(closed.status).toBe(409);
  });

  it("lets an admin review an appeal against his own decision, recorded and audited as a self-review; a moderator still cannot", async () => {
    const admin = await staff("admin");
    const { id, seller } = await publishedListing();
    const notice = await report(listingNotice(id, "scam"), { as: await member() });
    expect(notice.status).toBe(201);
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: admin,
      body: { target: `listing:${id}`, templateId: "listing.remove.scam", details: "Avance par Wafacash exigée avant la visite." },
    });
    expect(decided.status).toBe(201);
    const decisionId = decided.body.decisionId;
    const appeal = await publicCall<OpenAppealResponse>(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId, text: "Je n'ai demandé aucune avance." } });
    expect(appeal.status).toBe(201);

    const queue = await adminCall<AppealQueueResponse>(queueRoute, "GET", "/api/admin/appeals", { as: admin });
    expect(queue.body.items.find((item) => item.decisionId === decisionId)).toMatchObject({ reviewable: true, decidedBy: admin.uid });
    const reviewed = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, {
      as: admin,
      params: { decisionId },
      body: { outcome: "reversed", note: "Après relecture des messages, aucune demande d'avance." },
    });
    expect(reviewed.status).toBe(200);
    const outcomeDecisionId = reviewed.body.outcomeDecisionId as string;
    expect((await listing(id)).status).toBe("published");
    expect((await decision(decisionId)).appeal).toMatchObject({ status: "reversed", reviewer: admin.uid, selfReview: true, outcomeDecisionId });
    const view = await adminCall<{ decision: DecisionView }>(decisionRoute, "GET", `/api/admin/decisions/${decisionId}`, { as: admin, params: { id: decisionId } });
    expect(view.body.decision.appeal).toMatchObject({ status: "reversed", selfReview: true });
    // The audit log says who, when, which decision and the outcome.
    const entries = await audits("appeal.self_review", decisionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUid: admin.uid, actorRole: "admin", automated: false, reason: `outcome reversed; decided and reviewed by the same admin; decision ${outcomeDecisionId}` });
    expect(entries[0]!["at"]).toBeDefined();
    expect(await audits("appeal.reversed", decisionId)).toHaveLength(1);
    expect(mailTo(sendMail, "appealOutcome", seller.email)?.data).toMatchObject({ decisionId, outcome: "reversed" });

    // A moderator's own decision: still another moderator, or an admin.
    const { id: second, seller: seller2 } = await publishedListing();
    const noticed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${second}`, templateId: "listing.restrict", details: "Photos sans rapport avec l'objet." } });
    const appealed = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller2, body: { decisionId: noticed.body.decisionId, text: "Les photos montrent bien l'objet vendu." } });
    expect(appealed.status).toBe(201);
    const refused = await adminCall(reviewRoute, "POST", `/api/admin/appeals/${noticed.body.decisionId}`, { as: moderator, params: { decisionId: noticed.body.decisionId }, body: { outcome: "upheld", note: "Je maintiens ma décision." } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("same_reviewer");
    const upheld = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${noticed.body.decisionId}`, { as: admin, params: { decisionId: noticed.body.decisionId }, body: { outcome: "upheld", note: "Les photos ne montrent pas l'objet vendu." } });
    expect(upheld.status).toBe(200);
    expect((await decision(noticed.body.decisionId)).appeal).toMatchObject({ status: "upheld", reviewer: admin.uid });
    expect((await decision(noticed.body.decisionId)).appeal?.selfReview).toBeUndefined();
    expect(await audits("appeal.self_review", noticed.body.decisionId)).toHaveLength(0);
  });

  it("refuses visitors, members and the public host on the back-office routes", async () => {
    const body = { target: "listing:abcdefgh", templateId: "listing.no_action" };
    expect((await adminCall(decideRoute, "POST", "/api/admin/decisions", { body })).status).toBe(401);
    expect((await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body, host: "localhost:3000" })).status).toBe(404);
    const someone = await member();
    expect((await publicCall(decideRoute, "POST", "/api/admin/decisions", { as: someone, body })).status).toBe(404);
    const invalid = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { ...body, templateId: "authority.remove" } });
    expect(invalid.status).toBe(400);
    const missing = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body });
    expect(missing.status).toBe(404);
  });
});
