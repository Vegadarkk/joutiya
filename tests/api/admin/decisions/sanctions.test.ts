import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Sanctions ladder (design D14, D16) against the Firebase emulators: a suspension decided with a
// content decision (its own statement, `st` claim, status, suspensions/{uid}, listings paused by
// moderation) and its lift by the hourly job; who may ban (403 sanction_not_allowed); a P0
// confirmed by a moderator bans; a ban (account disabled, listings removed) appealed through the
// signed link and reversed; a suspension reversed on appeal.

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
import { GET as userRoute } from "@/app/api/admin/users/[uid]/route";
import { GET as lookupRoute } from "@/app/api/admin/users/route";
import { GET as linkViewRoute, POST as linkRoute } from "@/app/api/appeals/link/route";
import { POST as appealRoute } from "@/app/api/appeals/route";
import { POST as pauseRoute } from "@/app/api/listings/[id]/pause/route";
import type { AppealableDecision, DecideResponse, OpenAppealResponse, ReviewAppealResponse, UserModerationView } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { auth, db } from "@/lib/firebase/admin";
import { getClaims } from "@/lib/firebase/claims";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { liftSuspensions } from "@/worker/jobs/lift-suspensions";
import { api } from "../../listings/helpers";
import { listingNotice, member, publicIdOf, publishedListing, report } from "../../reports/helpers";
import { adminCall, audits, decision, listing, mailTo, privateAccount, publicCall, resignIn, staff, userStatus, type Staff } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;
let moderator: Staff;
let reviewer: Staff;
let adminStaff: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposal: async () => null });
  moderator = await staff("moderator");
  reviewer = await staff("moderator");
  adminStaff = await staff("admin");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

async function suspensionDoc(uid: string): Promise<Record<string, unknown> | undefined> {
  return (await db().collection(COLLECTIONS.suspensions).doc(uid).get()).data();
}

describe("suspension", () => {
  it("suspends the seller with a removal, pauses his other listings, and the hourly job lifts it", async () => {
    const first = await publishedListing();
    const seller = first.seller;
    const other = await publishedListing({ seller });
    const reporter = await member();
    expect((await report(listingNotice(first.id, "scam"), { as: reporter })).status).toBe(201);

    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", {
      as: moderator,
      body: { target: `listing:${first.id}`, templateId: "listing.remove.scam", sanction: { action: "suspend_account", durationDays: 7 } },
    });
    expect(decided.status).toBe(201);
    const sanctionId = decided.body.sanctionDecisionId as string;
    expect(sanctionId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await decision(sanctionId)).toMatchObject({ action: "suspend_account", durationDays: 7, target: { type: "user", id: seller.uid }, templateId: "user.suspend.7", reportIds: [] });
    expect((await getClaims(seller.uid)).st).toBe("suspended");
    expect(await userStatus(seller.uid)).toBe("suspended");
    const suspension = await suspensionDoc(seller.uid);
    expect(suspension?.["decisionId"]).toBe(sanctionId);
    expect((await privateAccount(seller.uid))["strikes"]).toMatchObject({ level: 2 });
    expect(await listing(first.id)).toMatchObject({ status: "removed" });
    expect(await listing(other.id)).toMatchObject({ status: "paused", pausedReason: "moderation" });
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ decisionId: sanctionId, action: "suspend_account", durationDays: 7, until: expect.any(String) });
    expect(await audits("decision.suspend_account", seller.uid)).toHaveLength(1);

    // The back office shows the account and proposes the next step.
    const view = await adminCall<{ user: UserModerationView }>(userRoute, "GET", `/api/admin/users/${seller.uid}`, { as: moderator, params: { uid: seller.uid } });
    expect(view.body.user).toMatchObject({ status: "suspended", strikes: { level: 2 }, nextStep: { action: "suspend_account", durationDays: 30 }, suspension: { decisionId: sanctionId } });
    const found = await adminCall<{ user: UserModerationView }>(lookupRoute, "GET", `/api/admin/users?publicId=${await publicIdOf(seller.uid)}`, { as: moderator });
    expect(found.body.user.uid).toBe(seller.uid);

    // Not ended yet: the job leaves it; 8 days later it is lifted.
    expect(await liftSuspensions(new Date())).toMatchObject({ lifted: 0 });
    // Other files' suspensions share the emulator (stream-revoke suspends for 7 days too): count this one at least.
    const lifted = await liftSuspensions(new Date(Date.now() + 8 * DAY_MS));
    expect(lifted.failed).toBe(0);
    expect(lifted.lifted).toBeGreaterThanOrEqual(1);
    expect((await getClaims(seller.uid)).st).toBeUndefined();
    expect(await userStatus(seller.uid)).toBe("active");
    expect(await suspensionDoc(seller.uid)).toBeUndefined();
    expect(await listing(other.id)).toMatchObject({ status: "published" });
    expect((await listing(other.id)).pausedReason).toBeUndefined();
    expect(await listing(first.id)).toMatchObject({ status: "removed" });
    expect(await audits("user.unsuspend", seller.uid)).toHaveLength(1);
  });

  it("reverses a suspension on appeal: claim dropped, account active, listings back, one strike off", async () => {
    const { id, seller } = await publishedListing();
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `user:${seller.uid}`, templateId: "user.suspend.7", details: "Annonces trompeuses répétées." } });
    expect(decided.status).toBe(201);
    expect(decided.body.sanctionDecisionId).toBeNull();
    expect(await listing(id)).toMatchObject({ status: "paused", pausedReason: "moderation" });

    // The suspended member signs in again (the sanction revoked the tokens) and appeals.
    const suspended = await resignIn(seller);
    const appeal = await publicCall<OpenAppealResponse>(appealRoute, "POST", "/api/appeals", { as: suspended, body: { decisionId: decided.body.decisionId, text: "Ces annonces décrivaient fidèlement les objets." } });
    expect(appeal.status).toBe(201);

    const reviewed = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${decided.body.decisionId}`, {
      as: reviewer,
      params: { decisionId: decided.body.decisionId },
      body: { outcome: "reversed", note: "Les annonces n'étaient pas trompeuses." },
    });
    expect(reviewed.status).toBe(200);
    expect((await getClaims(seller.uid)).st).toBeUndefined();
    expect(await userStatus(seller.uid)).toBe("active");
    expect(await suspensionDoc(seller.uid)).toBeUndefined();
    expect((await privateAccount(seller.uid))["strikes"]).toMatchObject({ level: 1 });
    expect(await listing(id)).toMatchObject({ status: "published" });
    expect(mailTo(sendMail, "appealOutcome", seller.email)?.data).toMatchObject({ outcome: "reversed" });
  });
});

describe("ban", () => {
  it("is refused to a moderator outside a P0 report, and nothing changes", async () => {
    const { id, seller } = await publishedListing();
    const direct = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `user:${seller.uid}`, templateId: "user.ban" } });
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe("sanction_not_allowed");
    const withContent = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.remove.scam", sanction: { action: "ban" } } });
    expect(withContent.status).toBe(403);
    expect((await auth().getUser(seller.uid)).disabled).toBe(false);
    expect(await listing(id)).toMatchObject({ status: "published" });
  });

  it("follows a P0 confirmed by a moderator", async () => {
    const { id, seller } = await publishedListing();
    expect((await report(listingNotice(id, "minors"), { as: await member() })).status).toBe(201);
    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.remove.p0" } });
    expect(decided.status).toBe(201);
    expect(await decision(decided.body.sanctionDecisionId as string)).toMatchObject({ action: "ban", templateId: "user.ban.p0" });
    expect((await auth().getUser(seller.uid)).disabled).toBe(true);
    expect(await userStatus(seller.uid)).toBe("banned");
  });

  it("disables the account and removes its listings; the banned seller appeals by link and the ban is reversed", async () => {
    const first = await publishedListing();
    const seller = first.seller;
    const paused = await publishedListing({ seller });
    expect((await api(pauseRoute, "POST", `/api/listings/${paused.id}/pause`, { member: seller, body: {} })).status).toBe(200);

    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: adminStaff, body: { target: `user:${seller.uid}`, templateId: "user.ban", details: "Escroqueries répétées malgré deux suspensions." } });
    expect(decided.status).toBe(201);
    const banId = decided.body.decisionId;
    expect((await auth().getUser(seller.uid)).disabled).toBe(true);
    expect(await userStatus(seller.uid)).toBe("banned");
    for (const id of [first.id, paused.id]) expect((await listing(id)).moderation.lastDecisionId).toBe(banId);
    expect(await listing(first.id)).toMatchObject({ status: "removed" });
    expect(await listing(paused.id)).toMatchObject({ status: "removed" });
    expect((await privateAccount(seller.uid))["strikes"]).toMatchObject({ level: 3 });

    // The statement carries the signed link: the banned seller cannot sign in, he appeals with it.
    const token = mailTo(sendMail, "decisionNotice", seller.email)?.data.appealToken as string;
    expect(token).toBeTruthy();
    const shown = await publicCall<{ decision: AppealableDecision }>(linkViewRoute, "GET", `/api/appeals/link?token=${encodeURIComponent(token)}`);
    expect(shown.status).toBe(200);
    expect(shown.body.decision).toMatchObject({ decisionId: banId, by: "affected", action: "ban", appealable: true });
    const forged = await publicCall(linkRoute, "POST", "/api/appeals/link", { body: { token: `${token.split(".")[0]}.${"A".repeat(43)}`, text: "Je conteste ce bannissement." } });
    expect(forged.status).toBe(404);
    const appeal = await publicCall<OpenAppealResponse>(linkRoute, "POST", "/api/appeals/link", { body: { token, text: "Je conteste ce bannissement : ces annonces étaient honnêtes." } });
    expect(appeal.status).toBe(201);
    expect(appeal.body.by).toBe("affected");
    expect(mailTo(sendMail, "appealReceived", seller.email)).toBeDefined();

    const reviewed = await adminCall<ReviewAppealResponse>(reviewRoute, "POST", `/api/admin/appeals/${banId}`, { as: reviewer, params: { decisionId: banId }, body: { outcome: "reversed", note: "Les preuves ne suffisent pas pour un bannissement." } });
    expect(reviewed.status).toBe(200);
    expect((await auth().getUser(seller.uid)).disabled).toBe(false);
    expect(await userStatus(seller.uid)).toBe("active");
    expect((await privateAccount(seller.uid))["strikes"]).toMatchObject({ level: 2 });
    // Both come back published (the owner's pause is not remembered by a removal).
    expect(await listing(first.id)).toMatchObject({ status: "published" });
    expect(await listing(paused.id)).toMatchObject({ status: "published" });
    expect(await audits("appeal.reversed", banId)).toHaveLength(1);
  });
});
