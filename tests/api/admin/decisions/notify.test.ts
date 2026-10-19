import { FieldValue } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The statement of reasons sent again (design D13, audit D1a-08) against the Firebase emulators: a
// staff member re-sends the art. 17 mail of a stored decision (same facts, the moderator's words,
// the appeal link, a fresh idempotency key), audited; nothing to send for a dismissal.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { POST as notifyRoute } from "@/app/api/admin/decisions/[id]/notify/route";
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import type { DecideResponse, ResendNoticeResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { decisionRef } from "@/lib/decisions/repository";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import type { TemplateMail } from "@/lib/mail/types";
import * as limiter from "@/lib/rate-limit/limiter";
import { listingNotice, member, publishedListing, report } from "../../reports/helpers";
import { adminCall, audits, decision, mailTo, staff, type Staff } from "./helpers";

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposal: async () => null });
  moderator = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

describe("POST /api/admin/decisions/{id}/notify", () => {
  it("sends the statement again with the moderator's words and the appeal link, under a new key, and audits it", async () => {
    const { id, seller } = await publishedListing();
    expect((await report(listingNotice(id, "scam"), { as: await member() })).status).toBe(201);
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: moderator,
      body: { target: `listing:${id}`, templateId: "listing.remove.scam", details: "Paiement par Wafacash exigé avant toute visite.", sanction: { action: "suspend_account", durationDays: 7 } },
    });
    expect(decided.status).toBe(201);
    const decisionId = decided.body.decisionId;
    const sanctionId = decided.body.sanctionDecisionId as string;
    const first = mailTo(sendMail, "decisionNotice", seller.email);
    const mails = vi.mocked(sendMail).mock.calls.map(([mail]) => mail).filter((mail): mail is TemplateMail<"decisionNotice"> => mail.template === "decisionNotice");
    const removal = mails.find((mail) => mail.data.decisionId === decisionId);
    const suspension = mails.find((mail) => mail.data.decisionId === sanctionId);
    expect(removal?.idempotencyKey).toBe(`decisionNotice-${decisionId}`);
    expect(first).toBeDefined();
    vi.mocked(sendMail).mockClear();

    const resent = await adminCall<ResendNoticeResponse>(notifyRoute, "POST", `/api/admin/decisions/${decisionId}/notify`, { as: moderator, params: { id: decisionId } });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ decisionId, sent: true });
    expect(resent.body.notifiedAt).toBe((await decision(decisionId)).notifiedAt?.toISOString());
    const again = mailTo(sendMail, "decisionNotice", seller.email);
    expect(again?.idempotencyKey).toMatch(new RegExp(`^decisionNotice-${decisionId}-resend-\\d+$`));
    // Art. 17: the statement is never dropped by the mail quota.
    expect(again?.priority).toBe("security");
    expect(again?.data).toMatchObject({
      decisionId,
      action: "remove",
      targetType: "listing",
      title: removal?.data.title,
      details: "Paiement par Wafacash exigé avant toute visite.",
      durationDays: null,
      until: null,
      source: "notice",
      appealDeadline: removal?.data.appealDeadline,
    });
    expect(again?.data.appealToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const entries = await audits("decision.notify", decisionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUid: moderator.uid, actorRole: "moderator", automated: false, reason: expect.stringContaining("queued") });

    // The suspension's own statement: its length and end are rebuilt from the stored decision.
    vi.mocked(sendMail).mockClear();
    const sanctionResent = await adminCall<ResendNoticeResponse>(notifyRoute, "POST", `/api/admin/decisions/${sanctionId}/notify`, { as: moderator, params: { id: sanctionId } });
    expect(sanctionResent.status).toBe(200);
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ decisionId: sanctionId, action: "suspend_account", targetType: "user", durationDays: 7, until: suspension?.data.until, details: "Paiement par Wafacash exigé avant toute visite." });
  });

  it("refuses a decision without a statement (409), an unknown one (404) and an anonymous call (401)", async () => {
    const { id } = await publishedListing();
    expect((await report(listingNotice(id, "spam"), { as: await member() })).status).toBe(201);
    const dismissed = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    expect(dismissed.status).toBe(201);
    vi.mocked(sendMail).mockClear();
    const none = await adminCall(notifyRoute, "POST", `/api/admin/decisions/${dismissed.body.decisionId}/notify`, { as: moderator, params: { id: dismissed.body.decisionId } });
    expect(none.status).toBe(409);
    expect(await audits("decision.notify", dismissed.body.decisionId)).toHaveLength(0);
    expect((await adminCall(notifyRoute, "POST", `/api/admin/decisions/${"Z".repeat(20)}/notify`, { as: moderator, params: { id: "Z".repeat(20) } })).status).toBe(404);
    expect((await adminCall(notifyRoute, "POST", `/api/admin/decisions/${dismissed.body.decisionId}/notify`, { params: { id: dismissed.body.decisionId } })).status).toBe(401);
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

  it("refuses a decision reversed on appeal and one whose template has no statement mail (409)", async () => {
    const { id } = await publishedListing();
    expect((await report(listingNotice(id, "scam"), { as: await member() })).status).toBe(201);
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.remove.scam" } });
    expect(decided.status).toBe(201);
    const decisionId = decided.body.decisionId;
    const resend = () => adminCall(notifyRoute, "POST", `/api/admin/decisions/${decisionId}/notify`, { as: moderator, params: { id: decisionId } });

    await decisionRef(decisionId).update({ supersededBy: "Z".repeat(20) });
    vi.mocked(sendMail).mockClear();
    expect((await resend()).status).toBe(409);

    // A listing rejection or an automated hold: its own mail, outside the decision catalogue.
    await decisionRef(decisionId).update({ supersededBy: FieldValue.delete(), templateId: "listingRejected" });
    expect((await resend()).status).toBe(409);
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
    expect(await audits("decision.notify", decisionId)).toHaveLength(0);
  });
});
