import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/reports against the Firebase emulators (design D10, D12): visitors and members, the
// art. 16 fields, Turnstile, the limiters, duplicates, refusals (own content, unknown or private
// targets, abusive reporters), the stored notice and its effects on the target (open report counter,
// ads eligibility, legal hold), the P0 alert and the acknowledgement mail.

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { slaDueAt } from "@/config/report-reasons";
import { getListing } from "@/lib/db/repositories/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { alert } from "@/lib/alert";
import { sendMail } from "@/lib/mail";
import * as limiter from "@/lib/rate-limit/limiter";
import { getReport } from "@/lib/reports";
import { csrfToken } from "@/lib/security/csrf";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { capturedMails } from "../auth/helpers";
import { EXPLANATION, Jar, listingNotice, member, publicIdOf, publishedListing, report, seedConversation, visitor, type Member } from "./helpers";

const sendMailMock = vi.mocked(sendMail);
const alertMock = vi.mocked(alert);
const VISITOR = { name: "Nadia Visiteuse", email: "nadia.visiteuse@example.com" };

/** Limiters counted since the last clear: enforceLimit calls consumeLimit inside its own module (not seen by the spy). */
function limiterCalls(): string[] {
  return [...vi.mocked(limiter.enforceLimit).mock.calls, ...vi.mocked(limiter.consumeLimit).mock.calls].map(([id]) => id);
}

function clearLimiterCalls(): void {
  vi.mocked(limiter.enforceLimit).mockClear();
  vi.mocked(limiter.consumeLimit).mockClear();
}

let reporter: Member;
let listingId: string;
let seller: Member;

async function reportsOn(targetId: string) {
  const snapshot = await db().collection(COLLECTIONS.reports).where("target.id", "==", targetId).get();
  return snapshot.docs;
}

beforeAll(async () => {
  resetServerEnv();
  reporter = await member({ displayName: "Salma Signale" });
  ({ id: listingId, seller } = await publishedListing());
});

beforeEach(() => {
  limiter.resetRateLimiters();
  sendMailMock.mockClear();
  alertMock.mockClear();
  vi.mocked(verifyTurnstile).mockClear();
});

describe("visitor notices", () => {
  it("stores the art. 16 notice, counts it on the listing and acknowledges it (201)", async () => {
    const { id } = await publishedListing();
    const jar = visitor();
    const before = Date.now();
    const result = await report(listingNotice(id, "scam", VISITOR), { as: jar, headers: { cookie: `${jar.header()}; NEXT_LOCALE=ar` } });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ duplicate: false, priority: "P1", slaHours: 24 });
    expect(verifyTurnstile).toHaveBeenCalledWith("tok", expect.objectContaining({ action: "report" }));

    const stored = (await getReport(result.body.reportId))!;
    expect(stored).toMatchObject({
      target: { type: "listing", id, ownerUid: expect.any(String) },
      reasonId: "scam",
      priority: "P1",
      explanation: EXPLANATION,
      goodFaith: true,
      source: "user",
      reporter: { name: VISITOR.name, email: VISITOR.email, locale: "ar", trusted: false },
      hidden: false,
      status: "open",
    });
    expect(stored.reporter.uid).toBeUndefined();
    expect(stored.reporter.ipPrefixHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.reporter.ipPrefixHash).not.toContain(jar.ip);
    expect(stored.slaDueAt.getTime() - stored.createdAt.getTime()).toBe(24 * 3_600_000);
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.purgeAt.getUTCFullYear()).toBe(stored.createdAt.getUTCFullYear() + 5);
    expect(stored.strongSignal).toBeUndefined();

    const listing = (await getListing(id))!;
    expect(listing.moderation.openReports).toBe(1);
    expect(listing.moderation.hiddenBy).toBeUndefined();
    expect(listing.adsEligible).toBe(false);
    expect(listing.legalHold).toContain(`report:${result.body.reportId}`);

    const mails = capturedMails(sendMailMock).filter((mail) => mail.template === "reportReceived");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: VISITOR.email, locale: "ar", priority: "bulk", data: { displayName: VISITOR.name, reportId: result.body.reportId, targetType: "listing", reasonId: "scam", slaHours: 24, urgent: false } });
    expect(alertMock).not.toHaveBeenCalled();
    // The visitor keeps a device cookie; the Turnstile pass is set for 30 minutes.
    expect(result.response.headers.getSetCookie().some((line) => line.startsWith("__Host-tsv="))).toBe(true);
  });

  it("requires a name and an e-mail address unless the reason is P0 (art. 16(2)(c))", async () => {
    const jar = visitor();
    const missing = await report(listingNotice(listingId, "misleading"), { as: jar });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_body");
    const p0 = await report(listingNotice(listingId, "minors"), { as: jar });
    expect(p0.status).toBe(201);
    expect(p0.body.priority).toBe("P0");
    expect(capturedMails(sendMailMock).filter((mail) => mail.template === "reportReceived")).toHaveLength(0);
    // Every P0 alerts at once, without personal data, the report id in the title.
    expect(alertMock).toHaveBeenCalledTimes(1);
    const event = alertMock.mock.calls[0]![0];
    expect(event).toMatchObject({ severity: "P0", title: `Signalement P0 ${p0.body.reportId}` });
    expect(event.body).toContain("Signal fort : non");
    expect(event.body).not.toContain(listingId);
  });

  it("refuses a failed Turnstile check (403) and writes nothing", async () => {
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, codes: ["invalid-input-response"] });
    const { id } = await publishedListing();
    const result = await report(listingNotice(id, "spam", VISITOR), { as: visitor() });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("turnstile_failed");
    expect(await reportsOn(id)).toHaveLength(0);
    expect((await getListing(id))!.moderation.openReports).toBe(0);
  });

  it("needs an account to report a message (401) and the same origin (403)", async () => {
    const message = await report({ target: { type: "message", id: "AbCdEfGhIjKlMnOpQrStUv/a1B2c3D4e5F6g7H8i9J0" }, reasonId: "harassment", explanation: EXPLANATION, goodFaith: true, ...VISITOR }, { as: visitor() });
    expect(message.status).toBe(401);
    const foreign = await report(listingNotice(listingId, "spam", VISITOR), { as: visitor(), origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("origin");
  });

  it("deduplicates by device: the second notice answers the open report (200)", async () => {
    const { id } = await publishedListing();
    const jar = visitor();
    const first = await report(listingNotice(id, "misleading", VISITOR), { as: jar });
    const second = await report(listingNotice(id, "counterfeit", VISITOR), { as: jar });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ reportId: first.body.reportId, duplicate: true, priority: "P2" });
    expect(await reportsOn(id)).toHaveLength(1);
    expect((await getListing(id))!.moderation.openReports).toBe(1);
  });

  it("caps the acknowledgements at 2 per address per day, sent as bulk (audit D1a-04)", async () => {
    const email = "Cible.Inconnue@example.com";
    const ids: string[] = [];
    for (const reasonId of ["scam", "misleading", "spam"]) {
      const { id } = await publishedListing();
      const result = await report(listingNotice(id, reasonId, { name: "Anonyme", email: reasonId === "spam" ? email.toLowerCase() : email }), { as: visitor() });
      expect(result.status).toBe(201);
      ids.push(result.body.reportId);
    }
    const mails = capturedMails(sendMailMock).filter((mail) => mail.template === "reportReceived");
    expect(mails.map((mail) => (mail.data as { reportId: string }).reportId)).toEqual(ids.slice(0, 2));
    expect(mails.every((mail) => mail.priority === "bulk")).toBe(true);
    // The third notice stands and answers with its id: the mail is a courtesy.
    expect((await getReport(ids[2]!))?.status).toBe("open");
    expect(limiterCalls().filter((id) => id === "report.ack.email")).toHaveLength(3);
  });

  it("counts the visitor limiters: device, IP, and the P0 ones", async () => {
    clearLimiterCalls();
    await report(listingNotice(listingId, "threat"), { as: visitor() });
    const ids = limiterCalls();
    expect(ids).toEqual(expect.arrayContaining(["report.device", "report.ip", "report.p0.device", "report.p0.ip"]));
    expect(ids).not.toContain("report.uid");
  });
});

describe("member notices", () => {
  it("uses the account (no name or e-mail stored), acknowledges to the account address", async () => {
    const { id } = await publishedListing();
    const result = await report(listingNotice(id, "illegal_item", { name: "Ignored Name", email: "ignored@example.com" }), { as: reporter });
    expect(result.status).toBe(201);
    const stored = (await getReport(result.body.reportId))!;
    expect(stored.reporter.uid).toBe(reporter.uid);
    expect(stored.reporter.name).toBeUndefined();
    expect(stored.reporter.email).toBeUndefined();
    const mail = capturedMails(sendMailMock).find((item) => item.template === "reportReceived");
    expect(mail).toMatchObject({ to: reporter.email, locale: "fr", data: { displayName: "Salma Signale" } });
  });

  it("never caps a member's acknowledgements: a visitor typing the member's address cannot use them up", async () => {
    for (const reasonId of ["scam", "misleading"]) {
      const { id } = await publishedListing();
      expect((await report(listingNotice(id, reasonId, { name: "Anonyme", email: reporter.email }), { as: visitor() })).status).toBe(201);
    }
    clearLimiterCalls();
    sendMailMock.mockClear();
    const { id } = await publishedListing();
    const result = await report(listingNotice(id, "spam"), { as: reporter });
    expect(result.status).toBe(201);
    const mails = capturedMails(sendMailMock).filter((mail) => mail.template === "reportReceived");
    expect(mails.map((mail) => (mail.data as { reportId: string }).reportId)).toEqual([result.body.reportId]);
    expect(limiterCalls()).not.toContain("report.ack.email");
  });

  it("checks CSRF on a member's notice", async () => {
    const result = await report(listingNotice(listingId, "spam"), { as: reporter, csrf: false });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("csrf");
  });

  it("deduplicates the same account, but a more urgent reason is a new report", async () => {
    const { id } = await publishedListing();
    const spam = await report(listingNotice(id, "spam"), { as: reporter });
    const again = await report(listingNotice(id, "duplicate"), { as: reporter });
    const urgent = await report(listingNotice(id, "minors"), { as: reporter });
    expect([spam.status, again.status, urgent.status]).toEqual([201, 200, 201]);
    expect(again.body).toMatchObject({ reportId: spam.body.reportId, duplicate: true });
    expect(urgent.body.reportId).not.toBe(spam.body.reportId);
    expect((await getListing(id))!.moderation.openReports).toBe(2);
  });

  it("counts the member limiters and escalates on the IP", async () => {
    const { id } = await publishedListing();
    clearLimiterCalls();
    await report(listingNotice(id, "terrorism"), { as: reporter });
    const ids = limiterCalls();
    expect(ids).toEqual(expect.arrayContaining(["report.uid", "report.p0.uid", "report.p0.device", "report.p0.ip", "report.ip"]));
    expect(ids).not.toContain("report.device");
  });

  it("refuses one's own listing, profile or message (403 report_not_allowed)", async () => {
    const own = await report(listingNotice(listingId, "spam"), { as: seller });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("report_not_allowed");
    const profile = await report({ target: { type: "user", id: await publicIdOf(reporter.uid) }, reasonId: "spam", explanation: EXPLANATION, goodFaith: true }, { as: reporter });
    expect(profile.status).toBe(403);
    expect(profile.body.error.code).toBe("report_not_allowed");
  });

  it("refuses unknown and never-public listings (422 report_target_invalid)", async () => {
    const unknown = await report(listingNotice("zzzz2345", "spam"), { as: reporter });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("report_target_invalid");
    const pro = await report({ target: { type: "pro", id: "boutique-casa" }, reasonId: "spam", explanation: EXPLANATION, goodFaith: true }, { as: reporter });
    expect(pro.status).toBe(422);
  });

  it("refuses an abusive reporter (art. 23) with 403 report_not_allowed", async () => {
    const abusive = await member();
    await db()
      .collection(COLLECTIONS.users)
      .doc(abusive.uid)
      .collection(COLLECTIONS.userPrivate)
      .doc(COLLECTIONS.userPrivateDoc)
      .update({ reporter: { recent: [false, false, false], total: 3, abusiveUntil: new Date(Date.now() + 86_400_000) } });
    const result = await report(listingNotice(listingId, "spam"), { as: abusive });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("report_not_allowed");
  });

  it("lets a suspended account report", async () => {
    const suspended = await member();
    await setClaims(suspended.uid, { role: "individual", st: "suspended" });
    const minted = await createSessionForUid(suspended.uid);
    const jar = new Jar();
    jar.cookies.set("__Host-session", minted.cookie);
    jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
    const result = await report(listingNotice(listingId, "misleading"), { as: { ...suspended, jar } });
    expect(result.status).toBe(201);
  });
});

describe("profile and message targets", () => {
  it("resolves a profile's publicId to its account and holds the account's private data", async () => {
    const target = await member();
    const publicId = await publicIdOf(target.uid);
    const result = await report({ target: { type: "user", id: publicId }, reasonId: "impersonation", explanation: EXPLANATION, goodFaith: true }, { as: reporter });
    expect(result.status).toBe(201);
    const stored = (await getReport(result.body.reportId))!;
    expect(stored.target).toEqual({ type: "user", id: target.uid, ownerUid: target.uid, publicId });
    const account = await db().collection(COLLECTIONS.users).doc(target.uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).get();
    expect(account.get("legalHold")).toEqual([`report:${result.body.reportId}`]);
  });

  it("lets a participant report the other participant's message and holds the conversation", async () => {
    const { id, seller: owner } = await publishedListing();
    const buyer = await member();
    const { cid, mid } = await seedConversation(id, buyer, owner, owner);
    const result = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: buyer });
    expect(result.status).toBe(201);
    const stored = (await getReport(result.body.reportId))!;
    expect(stored.target).toEqual({ type: "message", id: `${cid}/${mid}`, ownerUid: owner.uid, listingId: id });
    const conversation = await db().collection(COLLECTIONS.conversations).doc(cid).get();
    expect(conversation.get("legalHold")).toEqual([`report:${result.body.reportId}`]);
    // The listing of the conversation is not touched by a message report.
    expect((await getListing(id))!.moderation.openReports).toBe(0);

    const own = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: owner });
    expect(own.status).toBe(403);
    const outsider = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "scam", explanation: EXPLANATION, goodFaith: true }, { as: reporter });
    expect(outsider.status).toBe(422);
    expect(outsider.body.error.code).toBe("report_target_invalid");
  });
});

describe("reasons and SLA", () => {
  it("refuses a reason that does not apply to the target type", async () => {
    const result = await report(listingNotice(listingId, "harassment"), { as: reporter });
    expect(result.status).toBe(400);
  });

  it("dates the SLA from the reason's priority", () => {
    const at = new Date("2026-10-16T10:00:00Z");
    expect(slaDueAt("P0", at).toISOString()).toBe("2026-10-16T11:00:00.000Z");
    expect(slaDueAt("P3", at).toISOString()).toBe("2026-10-23T10:00:00.000Z");
  });
});
