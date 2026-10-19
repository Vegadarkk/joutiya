import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Authority requests register (design D17, D18) against the Firebase emulators: admin only; a
// removal order holds and removes the scoped listing through an authority report and a decision
// "authority_order" (no appeal link), holds the account and freezes the conversation, which staff
// may then read with a reason (audited); closing releases every hold.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { GET as getAuthority, PATCH as patchAuthority } from "@/app/api/admin/authorities/[id]/route";
import { GET as listAuthorities, POST as createAuthority } from "@/app/api/admin/authorities/route";
import { GET as readConversation } from "@/app/api/admin/conversations/[cid]/route";
import { POST as appealRoute } from "@/app/api/appeals/route";
import type { AuthorityRequestView, CreateAuthorityResponse, StaffConversationView } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { getReport } from "@/lib/reports";
import { member, publishedListing, seedConversation } from "../../reports/helpers";
import { adminCall, audits, decision, listing, mailTo, privateAccount, publicCall, staff, type Staff } from "./helpers";

let moderator: Staff;
let adminStaff: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposal: async () => null });
  moderator = await staff("moderator");
  adminStaff = await staff("admin");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

async function conversation(cid: string): Promise<Record<string, unknown>> {
  return (await db().collection(COLLECTIONS.conversations).doc(cid).get()).data() ?? {};
}

describe("authority requests", () => {
  it("are admin only", async () => {
    expect((await adminCall(listAuthorities, "GET", "/api/admin/authorities", { as: moderator })).status).toBe(403);
    expect((await adminCall(createAuthority, "POST", "/api/admin/authorities", { as: moderator, body: {} })).status).toBe(403);
  });

  it("execute a removal order: holds, freeze, authority report, decision without appeal; closing releases them", async () => {
    const { id, seller } = await publishedListing();
    const buyer = await member();
    const { cid } = await seedConversation(id, buyer, seller, seller);
    const created = await adminCall<CreateAuthorityResponse>(createAuthority, "POST", "/api/admin/authorities", {
      as: adminStaff,
      body: {
        authority: "Office anti-terroriste (TCO)",
        country: "FR",
        legalBasis: "Règlement (UE) 2021/784, art. 3",
        kind: "removal_order",
        scope: [`listing:${id}`, `user:${seller.uid}`, `conversation:${cid}`, "listing:zzzzzzzz"],
        identityCheck: { method: "Portail PHAROS, injonction signée" },
        receivedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        reasonId: "terrorism",
      },
    });
    expect(created.status).toBe(201);
    const request = created.body.request;
    const hold = `authority:${request.id}`;
    expect(request).toMatchObject({ status: "open", kind: "removal_order", holds: [hold], createdBy: adminStaff.uid, identityCheck: { by: adminStaff.uid } });
    expect(created.body.missing).toEqual(["listing:zzzzzzzz"]);
    expect(created.body.decisionIds).toHaveLength(1);
    expect(request.reportIds).toHaveLength(1);

    const removed = await listing(id);
    expect(removed.status).toBe("removed");
    expect(removed.legalHold).toContain(hold);
    const decided = await decision(created.body.decisionIds[0] as string);
    expect(decided).toMatchObject({ origin: "authority_order", templateId: "authority.remove", ground: { type: "illegal" }, decidedBy: adminStaff.uid });
    expect(await getReport(request.reportIds[0] as string)).toMatchObject({ source: "authority", status: "actioned", authorityRequestId: request.id });
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ source: "authority_order", appealToken: null });
    expect((await privateAccount(seller.uid))["legalHold"]).toContain(hold);
    expect(await conversation(cid)).toMatchObject({ status: "frozen" });
    expect((await conversation(cid))["legalHold"]).toContain(hold);
    expect(await audits("authority.create", request.id)).toHaveLength(1);

    // Not appealable on Joutiya (the issuing State's courts).
    const appeal = await publicCall(appealRoute, "POST", "/api/appeals", { as: seller, body: { decisionId: decided.id, text: "Je conteste ce retrait." } });
    expect(appeal.status).toBe(409);
    expect(appeal.body.error.code).toBe("appeal_closed");

    // D18: staff read the held conversation with a reason, audited.
    const noReason = await adminCall(readConversation, "GET", `/api/admin/conversations/${cid}`, { as: moderator, params: { cid } });
    expect(noReason.status).toBe(400);
    const read = await adminCall<{ conversation: StaffConversationView }>(readConversation, "GET", `/api/admin/conversations/${cid}?reason=${encodeURIComponent("Réquisition TCO en cours")}`, { as: moderator, params: { cid } });
    expect(read.status).toBe(200);
    expect(read.body.conversation).toMatchObject({ cid, status: "frozen", access: { reportIds: [], authorityHolds: [hold] } });
    expect(read.body.conversation.messages).toHaveLength(1);
    expect(await audits("conversation.read", cid)).toHaveLength(1);

    const listed = await adminCall<{ items: AuthorityRequestView[] }>(listAuthorities, "GET", "/api/admin/authorities?status=open", { as: adminStaff });
    expect(listed.body.items.some((item) => item.id === request.id)).toBe(true);
    const got = await adminCall<{ request: AuthorityRequestView }>(getAuthority, "GET", `/api/admin/authorities/${request.id}`, { as: adminStaff, params: { id: request.id } });
    expect(got.body.request.id).toBe(request.id);

    const answered = await adminCall<{ request: AuthorityRequestView }>(patchAuthority, "PATCH", `/api/admin/authorities/${request.id}`, { as: adminStaff, params: { id: request.id }, body: { status: "answered", response: "Contenu retiré en 12 minutes." } });
    expect(answered.body.request).toMatchObject({ status: "answered", response: "Contenu retiré en 12 minutes." });
    const closed = await adminCall<{ request: AuthorityRequestView }>(patchAuthority, "PATCH", `/api/admin/authorities/${request.id}`, { as: adminStaff, params: { id: request.id }, body: { status: "closed" } });
    expect(closed.body.request).toMatchObject({ status: "closed", closedAt: expect.any(String) });
    expect((await listing(id)).legalHold).not.toContain(hold);
    expect((await privateAccount(seller.uid))["legalHold"] ?? []).not.toContain(hold);
    expect(await conversation(cid)).toMatchObject({ status: "open" });
    const purgeAt = (await db().collection(COLLECTIONS.authorityRequests).doc(request.id).get()).get("purgeAt").toDate() as Date;
    expect(purgeAt.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 5);
    expect((await adminCall(patchAuthority, "PATCH", `/api/admin/authorities/${request.id}`, { as: adminStaff, params: { id: request.id }, body: { status: "closed" } })).status).toBe(409);

    // Released: the conversation is no longer readable without a report.
    const after = await adminCall(readConversation, "GET", `/api/admin/conversations/${cid}?reason=${encodeURIComponent("Contrôle après clôture")}`, { as: moderator, params: { cid } });
    expect(after.status).toBe(403);
  });

  it("keep the statement from the user under a non-disclosure order", async () => {
    const { id, seller } = await publishedListing();
    const created = await adminCall<CreateAuthorityResponse>(createAuthority, "POST", "/api/admin/authorities", {
      as: adminStaff,
      body: {
        authority: "Parquet de Rabat",
        country: "MA",
        legalBasis: "Code de procédure pénale",
        kind: "removal_order",
        scope: [`listing:${id}`],
        identityCheck: { method: "Rappel du standard du parquet" },
        receivedAt: new Date().toISOString(),
        reasonId: "illegal_item",
        notifyAffected: false,
      },
    });
    expect(created.status).toBe(201);
    expect(await listing(id)).toMatchObject({ status: "removed" });
    expect(mailTo(sendMail, "decisionNotice", seller.email)).toBeUndefined();
    expect((await decision(created.body.decisionIds[0] as string)).notifiedAt).toBeUndefined();
  });
});
