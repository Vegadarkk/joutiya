import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Notifier appeals (art. 20 DSA, design D16) against the Firebase emulators: a member whose notice
// was dismissed appeals signed in; a visitor appeals through the signed link of the outcome mail;
// another moderator reverses the dismissal with the measure to take, and the original reports
// become founded. Link tokens are bound to their decision, signed, and expire.

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
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import { GET as linkViewRoute, POST as linkRoute } from "@/app/api/appeals/link/route";
import { POST as appealRoute } from "@/app/api/appeals/route";
import { appealToken } from "@/lib/decisions/appeal-token";
import type { AppealableDecision, DecideResponse, OpenAppealResponse, ReviewAppealResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { adminCall, decision, listing, mailTo, publicCall, reportStatus, staff, type Staff } from "../admin/decisions/helpers";
import { listingNotice, member, publishedListing, report, visitor } from "../reports/helpers";

let moderator: Staff;
let reviewer: Staff;
const requestAppealReview = vi.fn(async () => undefined);
const markAiDecision = vi.fn(async () => undefined);
/** The agent's appeal_review proposal on every decision: "reject" = the appeal looks unfounded (uphold). */
const PROPOSAL_ID = "P".repeat(20);

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview, markAiDecision, appealProposal: async () => ({ id: PROPOSAL_ID, action: "reject" }) });
  moderator = await staff("moderator");
  reviewer = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
  markAiDecision.mockClear();
});

describe("notifier appeals", () => {
  it("a member's dismissed notice, appealed signed in and reversed: the listing is removed, the report founded", async () => {
    const { id, seller } = await publishedListing();
    const reporter = await member({ displayName: "Yasmine Signale" });
    const notice = await report(listingNotice(id, "counterfeit"), { as: reporter });
    expect(notice.status).toBe(201);
    const dismissed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    expect(dismissed.status).toBe(201);
    const decisionId = dismissed.body.decisionId;

    // The seller cannot appeal a decision in his favour.
    const sellerAppeal = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId, text: "Je ne suis pas d'accord." } });
    expect(sellerAppeal.status).toBe(403);
    expect(sellerAppeal.body.error.code).toBe("appeal_not_allowed");

    const appeal = await publicCall<OpenAppealResponse>(appealRoute, "POST", "/api/appeals", { as: reporter, body: { decisionId, text: "Le logo est une contrefaçon évidente, voir la photo 2." } });
    expect(appeal.status).toBe(201);
    expect(appeal.body.by).toBe("reporter");
    expect((await decision(decisionId)).appeal).toMatchObject({ status: "open", by: "reporter", reportId: notice.body.reportId });
    expect(mailTo(sendMail, "appealReceived", reporter.email)).toBeDefined();
    expect(requestAppealReview).toHaveBeenCalledWith(decisionId);

    // Reversing a dismissal needs the measure to take.
    const bare = await adminCall(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, { as: reviewer, params: { decisionId }, body: { outcome: "reversed", note: "La contrefaçon est avérée." } });
    expect(bare.status).toBe(400);
    const reviewed = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, {
      as: reviewer,
      params: { decisionId },
      body: { outcome: "reversed", note: "La contrefaçon est avérée.", templateId: "listing.remove.counterfeit" },
    });
    expect(reviewed.status).toBe(200);
    const removalId = reviewed.body.outcomeDecisionId as string;
    expect(await listing(id)).toMatchObject({ status: "removed" });
    expect(await decision(removalId)).toMatchObject({ action: "remove", supersedes: decisionId, reportIds: [notice.body.reportId], aiDecisionId: PROPOSAL_ID });
    expect(await reportStatus(notice.body.reportId)).toMatchObject({ status: "actioned", outcome: "founded", decisionId: removalId });
    // The agent proposed to uphold: the reversal rejects its proposal, grounded on the new decision (D1b-08).
    expect(markAiDecision).toHaveBeenCalledWith(PROPOSAL_ID, "rejected", reviewer.uid, removalId);
    expect(mailTo(sendMail, "appealOutcome", reporter.email)?.data).toMatchObject({ outcome: "reversed", by: "reporter" });
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ decisionId: removalId, action: "remove" });
  });

  it("a visitor's dismissed notice, appealed through the outcome mail's link and upheld", async () => {
    const { id } = await publishedListing();
    const guest = visitor();
    const notice = await report({ ...listingNotice(id, "misleading"), name: "Visiteur Test", email: "visitor.appeal@example.com" }, { as: guest });
    expect(notice.status).toBe(201);
    const dismissed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    const decisionId = dismissed.body.decisionId;
    const token = mailTo(sendMail, "reportOutcome", "visitor.appeal@example.com")?.data.appealToken as string;
    expect(token).toBeTruthy();

    const shown = await publicCall<{ decision: AppealableDecision }>(linkViewRoute, "GET", `/api/appeals/link?token=${encodeURIComponent(token)}`);
    expect(shown.body.decision).toMatchObject({ decisionId, by: "reporter", appealable: true, action: "no_action" });
    const appeal = await publicCall<OpenAppealResponse>(linkRoute, "POST", "/api/appeals/link", { body: { token, text: "L'annonce annonce un modèle qui n'existe pas." } });
    expect(appeal.status).toBe(201);
    expect(appeal.body.by).toBe("reporter");
    const twice = await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token, text: "L'annonce annonce un modèle qui n'existe pas." } });
    expect(twice.status).toBe(409);

    const upheld = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, { as: reviewer, params: { decisionId }, body: { outcome: "upheld", note: "Le modèle existe bien, référence vérifiée." } });
    expect(upheld.status).toBe(200);
    expect(upheld.body.outcomeDecisionId).toBeNull();
    expect((await decision(decisionId)).appeal).toMatchObject({ status: "upheld", reviewer: reviewer.uid });
    expect(markAiDecision).toHaveBeenCalledWith(PROPOSAL_ID, "confirmed", reviewer.uid, decisionId);
    expect(await listing(id)).toMatchObject({ status: "published" });
    expect(mailTo(sendMail, "appealOutcome", "visitor.appeal@example.com")?.data).toMatchObject({ outcome: "upheld", by: "reporter", note: "Le modèle existe bien, référence vérifiée." });
    const again = await adminCall(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, { as: reviewer, params: { decisionId }, body: { outcome: "upheld", note: "Deuxième examen inutile." } });
    expect(again.status).toBe(409);
  });

  it("marks the proposal with the reviewer's own verdict when the review carries one", async () => {
    const { id } = await publishedListing();
    const reporter = await member();
    expect((await report(listingNotice(id, "duplicate"), { as: reporter })).status).toBe(201);
    const dismissed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    const decisionId = dismissed.body.decisionId;
    expect((await publicCall(appealRoute, "POST", "/api/appeals", { as: reporter, body: { decisionId, text: "La même annonce existe déjà trois fois." } })).status).toBe(201);
    const upheld = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decisionId}`, {
      as: reviewer,
      params: { decisionId },
      body: { outcome: "upheld", note: "Les annonces visent des objets différents.", ai: { decisionId: "Q".repeat(20), outcome: "edited" } },
    });
    expect(upheld.status).toBe(200);
    expect(markAiDecision).toHaveBeenCalledTimes(1);
    expect(markAiDecision).toHaveBeenCalledWith("Q".repeat(20), "edited", reviewer.uid, decisionId);
  });

  it("refuses expired, forged and foreign tokens", async () => {
    const { id } = await publishedListing();
    const reporter = await member();
    const notice = await report(listingNotice(id, "spam"), { as: reporter });
    const dismissed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    const decisionId = dismissed.body.decisionId;
    const text = "Je conteste ce classement sans suite.";
    const expired = appealToken({ decisionId, by: "reporter", reportId: notice.body.reportId, expiresAt: new Date(Date.now() - 1000) });
    expect((await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token: expired, text } })).body.error.code).toBe("appeal_closed");
    const foreign = appealToken({ decisionId, by: "reporter", reportId: "Z".repeat(20), expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token: foreign, text } })).status).toBe(404);
    const missing = appealToken({ decisionId: "Q".repeat(20), by: "affected", expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token: missing, text } })).status).toBe(404);
    expect((await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token: "abc.def", text } })).status).toBe(400);
  });
});
