import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exit criterion "dismissed report restores and notifies" (design §5, D13, D15, D24) against the
// Firebase emulators: content hidden by a strong signal comes back when the reports are dismissed,
// the owner is told, the reporters get the outcome; a restricted account is restored; dismissals
// flagged manifestly unfounded count against the reporter (art. 23: warning after 3 in 30 days);
// bulk dismissal of P3 reports.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { POST as bulkRoute } from "@/app/api/admin/decisions/bulk/route";
import { POST as decideRoute } from "@/app/api/admin/decisions/route";
import type { BulkDismissResponse, DecideResponse } from "@/lib/decisions/contracts";
import { setDecisionAiHooks } from "@/lib/decisions/hooks";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { listingNotice, makeTrusted, member, publicIdOf, publishedListing, report, EXPLANATION } from "../../reports/helpers";
import { adminCall, decision, listing, mailTo, mailsOf, privateAccount, reportStatus, staff, userStatus, type Staff } from "./helpers";

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  setDecisionAiHooks({ requestAppealReview: async () => undefined, markAiDecision: async () => undefined, appealProposalId: async () => null });
  moderator = await staff("moderator");
});

beforeEach(() => {
  limiter.resetRateLimiters();
  vi.mocked(sendMail).mockClear();
});

describe("dismissal", () => {
  it("shows a hidden listing again, tells the seller and the reporter, and counts a manifestly unfounded notice", async () => {
    const { id, seller } = await publishedListing();
    const reporter = await member({ displayName: "Nadia Signale" });
    await makeTrusted(reporter);
    // Strong signals hide on P0 notices only (D11): a trusted reporter's threat notice.
    const notice = await report(listingNotice(id, "threat"), { as: reporter });
    expect(notice.status).toBe(201);
    const hidden = await listing(id);
    expect(hidden.moderation.hiddenBy?.reportId).toBe(notice.body.reportId);

    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action", manifestlyUnfounded: true } });
    expect(decided.status).toBe(201);
    expect(decided.body.action).toBe("no_action");
    const shown = await listing(id);
    expect(shown.status).toBe("published");
    expect(shown.moderation.hiddenBy).toBeUndefined();
    expect(shown.moderation.openReports).toBe(0);
    expect(shown.adsEligible).toBe(true);
    expect((await getSearchOutbox(id))?.op).toBe("upsert");
    expect(await reportStatus(notice.body.reportId)).toMatchObject({ status: "dismissed", outcome: "unfounded", manifestlyUnfounded: true });
    expect((await decision(decided.body.decisionId)).notifiedAt).toBeUndefined();

    expect(mailTo(sendMail, "contentRestored", seller.email)?.data).toMatchObject({ targetType: "listing", via: "report", decisionId: decided.body.decisionId });
    expect(mailTo(sendMail, "decisionNotice", seller.email)).toBeUndefined();
    const outcome = mailTo(sendMail, "reportOutcome", reporter.email);
    expect(outcome?.data).toMatchObject({ outcome: "dismissed", action: "no_action" });
    // The notifier may appeal the dismissal through the link of the outcome mail.
    expect(outcome?.data.appealToken).toMatch(/\./);

    const account = await privateAccount(reporter.uid);
    const stats = account["reporter"] as { recent: boolean[]; total: number; manifest?: unknown[] };
    expect(stats.recent.at(-1)).toBe(false);
    expect(stats.total).toBe(6);
    expect(stats.manifest).toHaveLength(1);
  });

  it("restricts a listing on the moderator's own initiative, then restores it", async () => {
    const { id, seller } = await publishedListing();
    const restricted = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.restrict", details: "Photos sans rapport avec l'objet." } });
    expect(restricted.status).toBe(201);
    const hidden = await listing(id);
    expect(hidden.moderation.hiddenBy).toMatchObject({ reportId: restricted.body.decisionId, signal: "trusted" });
    expect(hidden.adsEligible).toBe(false);
    expect((await decision(restricted.body.decisionId)).origin).toBe("own_initiative");
    expect(mailTo(sendMail, "decisionNotice", seller.email)?.data).toMatchObject({ action: "restrict_visibility", source: "own_initiative" });

    const restored = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.restore" } });
    expect(restored.status).toBe(201);
    expect((await listing(id)).moderation.hiddenBy).toBeUndefined();
    expect(mailTo(sendMail, "contentRestored", seller.email)).toBeDefined();
    // Nothing hidden, no report: nothing to decide.
    const again = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action" } });
    expect(again.status).toBe(409);
  });

  it("restores an account restricted by a strong signal, with its hidden listings", async () => {
    const { id, seller } = await publishedListing();
    const reporter = await member();
    await makeTrusted(reporter);
    const notice = await report({ target: { type: "user", id: await publicIdOf(seller.uid) }, reasonId: "threat", explanation: EXPLANATION, goodFaith: true }, { as: reporter });
    expect(notice.status).toBe(201);
    expect(await userStatus(seller.uid)).toBe("restricted");
    expect((await listing(id)).moderation.hiddenBy).toBeDefined();

    const decided = await adminCall<DecideResponse>(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `user:${seller.uid}`, templateId: "user.no_action" } });
    expect(decided.status).toBe(201);
    expect(await userStatus(seller.uid)).toBe("active");
    expect((await listing(id)).moderation.hiddenBy).toBeUndefined();
    expect(mailTo(sendMail, "contentRestored", seller.email)?.data).toMatchObject({ targetType: "user" });
    const account = await privateAccount(seller.uid);
    expect((account["legalHold"] as string[] | undefined) ?? []).not.toContain(`report:${notice.body.reportId}`);
  });

  it("warns a reporter after 3 manifestly unfounded notices in 30 days (art. 23)", async () => {
    const reporter = await member({ displayName: "Omar Abusif" });
    for (let index = 0; index < 3; index += 1) {
      const { id } = await publishedListing();
      const notice = await report(listingNotice(id, "spam"), { as: reporter });
      expect(notice.status).toBe(201);
      const decided = await adminCall(decideRoute, "POST", "/api/admin/decisions", { as: moderator, body: { target: `listing:${id}`, templateId: "listing.no_action", manifestlyUnfounded: [notice.body.reportId] } });
      expect(decided.status).toBe(201);
    }
    expect(mailTo(sendMail, "reporterWarning", reporter.email)?.data).toMatchObject({ kind: "warning", count: 3, windowDays: 30, until: null });
    expect((await privateAccount(reporter.uid))["reporter"]).toMatchObject({ warnedAt: expect.anything() });
  });
});

describe("bulk dismissal", () => {
  it("dismisses targets whose open reports are all P3 and skips the others", async () => {
    const reporter = await member();
    const spam1 = await publishedListing();
    const spam2 = await publishedListing();
    const scam = await publishedListing();
    const quiet = await publishedListing();
    for (const target of [spam1.id, spam2.id]) expect((await report(listingNotice(target, "spam"), { as: reporter })).status).toBe(201);
    expect((await report(listingNotice(scam.id, "scam"), { as: reporter })).status).toBe(201);

    const result = await adminCall<BulkDismissResponse>(bulkRoute, "POST", "/api/admin/decisions/bulk", {
      as: moderator,
      body: { targets: [`listing:${spam1.id}`, `listing:${spam2.id}`, `listing:${scam.id}`, `listing:${quiet.id}`] },
    });
    expect(result.status).toBe(200);
    expect(result.body.results.map((entry) => [entry.status, entry.reason ?? null])).toEqual([
      ["dismissed", null],
      ["dismissed", null],
      ["skipped", "not_p3"],
      ["skipped", "no_open_report"],
    ]);
    expect((await listing(spam1.id)).moderation.openReports).toBe(0);
    expect((await listing(scam.id)).moderation.openReports).toBe(1);
    expect(mailsOf(sendMail).filter((mail) => mail.template === "reportOutcome" && mail.to === reporter.email)).toHaveLength(2);
  });
});
