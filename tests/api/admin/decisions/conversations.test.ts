import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Staff access to conversations (design D18) and message decisions (D13, D16) against the Firebase
// emulators: no report, no access; a reported message opens the conversation with a reason
// (audited, rate limited) and its original text only; a removal hides the message for good and
// releases the report hold; the sender's appeal, reversed, restores it.

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
import { GET as readConversation } from "@/app/api/admin/conversations/[cid]/route";
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import { POST as appealRoute } from "@/app/api/appeals/route";
import type { DecideResponse, StaffConversationView } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { EXPLANATION, member, publishedListing, report, seedConversation } from "../../reports/helpers";
import { adminCall, audits, mailTo, publicCall, staff, type Staff } from "./helpers";

let moderator: Staff;
let reviewer: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposalId: async () => null });
  moderator = await staff("moderator");
  reviewer = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

const reason = encodeURIComponent("Signalement d'arnaque à examiner");

async function messageDoc(cid: string, mid: string): Promise<Record<string, unknown>> {
  return (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.messages).doc(mid).get()).data() ?? {};
}

describe("staff conversation access and message decisions", () => {
  it("opens only a reported conversation, hides and restores the message", async () => {
    const { id, seller } = await publishedListing();
    const buyer = await member();
    const { cid, mid } = await seedConversation(id, buyer, seller, seller, "Payez d'abord par Wafacash.");
    const path = (query = `?reason=${reason}`) => `/api/admin/conversations/${cid}${query}`;

    expect((await adminCall(readConversation, "GET", path(), { as: moderator, params: { cid } })).status).toBe(403);
    expect((await adminCall(readConversation, "GET", "/api/admin/conversations/not-a-cid?reason=" + reason, { as: moderator, params: { cid: "not-a-cid" } })).status).toBe(404);

    const notice = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: buyer });
    expect(notice.status).toBe(201);
    expect((await adminCall(readConversation, "GET", path("?reason=court"), { as: moderator, params: { cid } })).status).toBe(400);
    const read = await adminCall<{ conversation: StaffConversationView }>(readConversation, "GET", path(), { as: moderator, params: { cid } });
    expect(read.status).toBe(200);
    expect(read.body.conversation).toMatchObject({ cid, listingId: id, access: { reportIds: [notice.body.reportId], authorityHolds: [] } });
    expect(read.body.conversation.messages).toEqual([expect.objectContaining({ id: mid, from: "seller", reported: true, hidden: false })]);
    expect(read.body.conversation.seller.uid).toBe(seller.uid);
    expect(await audits("conversation.read", cid)).toHaveLength(1);
    expect((await db().collection(COLLECTIONS.conversations).doc(cid).get()).get("legalHold")).toContain(`report:${notice.body.reportId}`);

    // Removal: the message is hidden for good, the original kept as evidence, the hold released.
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `message:${cid}/${mid}`, templateId: "message.remove.scam" } });
    expect(decided.status).toBe(201);
    expect(await messageDoc(cid, mid)).toMatchObject({ hidden: true });
    expect((await db().collection(COLLECTIONS.conversations).doc(cid).get()).get("legalHold")).not.toContain(`report:${notice.body.reportId}`);
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ targetType: "message", action: "remove" });
    expect(mailTo(sendMail, "reportOutcome", buyer.email)?.data).toMatchObject({ outcome: "actioned", targetType: "message" });
    const after = await adminCall<{ conversation: StaffConversationView }>(readConversation, "GET", path(), { as: moderator, params: { cid } });
    expect(after.body.conversation.evidence[mid]).toEqual({ text: "Payez d'abord par Wafacash.", reason: "hidden" });

    // The sender appeals; another moderator reverses: the message is shown again.
    const appeal = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId: decided.body.decisionId, text: "Je proposais un paiement à la remise." } });
    expect(appeal.status).toBe(201);
    const reviewed = await adminCall(reviewRoute, "POST", `/api/admin/appeals/${decided.body.decisionId}`, { as: reviewer, params: { decisionId: decided.body.decisionId }, body: { outcome: "reversed", note: "Le message ne demande pas d'avance." } });
    expect(reviewed.status).toBe(200);
    const restored = await messageDoc(cid, mid);
    expect(restored["hidden"]).toBeUndefined();
    expect(restored["text"]).toBe("Payez d'abord par Wafacash.");
  });

  it("refuses an appeal from someone the decision does not concern", async () => {
    const { id, seller } = await publishedListing();
    const buyer = await member();
    const { cid, mid } = await seedConversation(id, buyer, seller, seller);
    expect((await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: buyer })).status).toBe(201);
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `message:${cid}/${mid}`, templateId: "message.remove.scam" } });
    expect(decided.status).toBe(201);
    const outsider = await member();
    const refused = await publicCall(appealRoute, "POST", "/api/appeals", { as: outsider, body: { decisionId: decided.body.decisionId, text: "Je ne suis pas concerné." } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("appeal_not_allowed");
    // The notifier cannot appeal a removal he obtained.
    const notifier = await publicCall(appealRoute, "POST", "/api/appeals", { as: buyer, body: { decisionId: decided.body.decisionId, text: "Je voudrais plus." } });
    expect(notifier.status).toBe(403);
  });
});
