import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Strong signals and visibility (design D11, D13 restore, D15) against the Firebase emulators. Exit
// criterion of phase 5: a lone false P0 hides nothing. A strong signal (trusted reporter, trusted
// flagger, distinct reporters, nudity score, authority) hides at once: the listing leaves the public
// page and the index (outbox), an account is restricted with its listings, a message is handed to
// the messaging lot. Then the decision helpers: closeReportsTx, recordReporterOutcomes (art. 23).

import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });
// Every export calls the messaging lot's own code; one test stubs a single hide.
vi.mock("@/lib/messaging", { spy: true });

import { alert } from "@/lib/alert";
import { getListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { updateUpload } from "@/lib/db/repositories/uploads";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { getPublicProfile, getPublishedBySlugId } from "@/lib/listings/public";
import { hideMessage, unhideMessage } from "@/lib/messaging";
import * as limiter from "@/lib/rate-limit/limiter";
import { closeReportsTx, createSystemReport, getReport, isTrustedReporter, openReportsForTarget, recordReporterOutcomes, targetKey, unhideTarget } from "@/lib/reports";
import { setAiConfigForTests } from "@/lib/ai/config";
import { setTriageRequester } from "@/lib/reports/hooks";
import { notifySearchIndex } from "@/lib/search/queue";
import { EXPLANATION, listingNotice, makeTrusted, member, publicIdOf, publishedListing, report, seedConversation, visitor, type Member } from "./helpers";

const alertMock = vi.mocked(alert);

async function auditActions(targetId: string): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", targetId).get();
  return snapshot.docs.map((doc) => String(doc.get("action")));
}

let ipBlock = 100;
/** An address in its own /24: distinct IP prefixes for the "multi" signal. */
function ownNetwork(): Record<string, string> {
  ipBlock += 1;
  return { "x-forwarded-for": `10.${ipBlock}.7.9` };
}

beforeAll(() => {
  resetServerEnv();
});

beforeEach(() => {
  limiter.resetRateLimiters();
  alertMock.mockClear();
  vi.mocked(notifySearchIndex).mockClear();
});

afterEach(async () => {
  await db().collection("config").doc("ai").delete();
  setAiConfigForTests(undefined);
  setTriageRequester(undefined);
});

describe("a lone P0 hides nothing (exit criterion)", () => {
  it("a member's first P0 report alerts but leaves the listing online", async () => {
    const { id } = await publishedListing();
    const result = await report(listingNotice(id, "minors"), { as: await member(), headers: ownNetwork() });
    expect(result.status).toBe(201);
    const stored = (await getReport(result.body.reportId))!;
    expect(stored.strongSignal).toBeUndefined();
    expect(stored.hidden).toBe(false);
    const listing = (await getListing(id))!;
    expect(listing.moderation.hiddenBy).toBeUndefined();
    expect(await getPublishedBySlugId(listing.slugId!)).not.toBeNull();
    expect((await getSearchOutbox(id))?.op).not.toBe("delete");
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]![0].body).toContain("Contenu masqué : non");
  });

  it("two P0 reports from one network are not distinct reporters", async () => {
    const { id } = await publishedListing();
    const network = ownNetwork();
    await report(listingNotice(id, "minors"), { as: await member(), headers: network });
    const second = await report(listingNotice(id, "minors"), { as: await member(), headers: network });
    expect((await getReport(second.body.reportId))!.hidden).toBe(false);
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();
  });

  it("a P1 report never hides, even from a trusted reporter", async () => {
    const { id } = await publishedListing();
    const trusted = await member();
    await makeTrusted(trusted);
    const result = await report(listingNotice(id, "scam"), { as: trusted, headers: ownNetwork() });
    expect((await getReport(result.body.reportId))!).toMatchObject({ hidden: false, reporter: { trusted: true } });
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();
  });
});

describe("strong signals hide a listing", () => {
  it("multi: two distinct accounts (uid, device, network) hide it from the page and the index", async () => {
    const { id, seller } = await publishedListing();
    const first = await report(listingNotice(id, "terrorism"), { as: await member(), headers: ownNetwork() });
    const second = await report(listingNotice(id, "terrorism"), { as: await member(), headers: ownNetwork() });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await getReport(first.body.reportId))!.hidden).toBe(false);
    const stored = (await getReport(second.body.reportId))!;
    expect(stored).toMatchObject({ strongSignal: "multi", hidden: true });

    const listing = (await getListing(id))!;
    expect(listing.moderation.hiddenBy).toMatchObject({ reportId: second.body.reportId, signal: "multi" });
    expect(listing.moderation.openReports).toBe(2);
    expect(listing.adsEligible).toBe(false);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "delete", version: listing.version });
    expect(vi.mocked(notifySearchIndex)).toHaveBeenCalledWith([id]);
    expect(await getPublishedBySlugId(listing.slugId!)).toBeNull();
    const profile = await getPublicProfile(await publicIdOf(seller.uid));
    expect(profile?.listings.map((card) => card.id)).not.toContain(id);
    expect(await auditActions(id)).toContain("listing.hide");
    expect(alertMock.mock.calls.at(-1)![0].body).toContain("Signal fort : oui (multi)");
    expect(alertMock.mock.calls.at(-1)![0].body).toContain("Contenu masqué : oui");

    // Restore (D13): visible again, back in the index; ads stay off while reports are open.
    expect(await unhideTarget({ type: "listing", id })).toBe(true);
    const restored = (await getListing(id))!;
    expect(restored.moderation.hiddenBy).toBeUndefined();
    expect(restored.moderation.openReports).toBe(2);
    expect(restored.adsEligible).toBe(false);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: restored.version });
    expect(await getPublishedBySlugId(restored.slugId!)).not.toBeNull();
    expect(await unhideTarget({ type: "listing", id })).toBe(false);
    expect(await auditActions(id)).toContain("listing.unhide");
  });

  it("two visitors do not hide: a pair of anonymous P0 notices stays P0 and online (audit D1a-03)", async () => {
    const { id } = await publishedListing();
    const first = await report(listingNotice(id, "terrorism"), { as: visitor(), headers: ownNetwork() });
    const second = await report(listingNotice(id, "terrorism"), { as: visitor(), headers: ownNetwork() });
    expect([first.status, second.status]).toEqual([201, 201]);
    const stored = (await getReport(second.body.reportId))!;
    expect(stored).toMatchObject({ priority: "P0", hidden: false });
    expect(stored.strongSignal).toBeUndefined();
    const listing = (await getListing(id))!;
    expect(listing.moderation.hiddenBy).toBeUndefined();
    expect(listing.moderation.openReports).toBe(2);
    expect(await getPublishedBySlugId(listing.slugId!)).not.toBeNull();
    expect(alertMock.mock.calls.at(-1)![0].body).toContain("Signal fort : non");
  });

  it("a visitor never completes a multi signal, but corroborates: one rank more urgent, never P0", async () => {
    const { id } = await publishedListing();
    const anonymous = (reasonId: string) => listingNotice(id, reasonId, { name: "Visiteur Corrobore", email: `corrobore-${reasonId}@example.com` });
    const guest = await report(listingNotice(id, "threat"), { as: visitor(), headers: ownNetwork() });
    expect(guest.body.priority).toBe("P0");
    const account = await report(listingNotice(id, "threat"), { as: await member(), headers: ownNetwork() });
    expect((await getReport(account.body.reportId))!).toMatchObject({ priority: "P0", hidden: false });
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();

    const misleading = await report(anonymous("misleading"), { as: visitor(), headers: ownNetwork() });
    expect(misleading.body).toMatchObject({ priority: "P1", slaHours: 24 });
    expect((await getReport(misleading.body.reportId))!).toMatchObject({ reasonId: "misleading", priority: "P1", hidden: false });
    const spam = await report(anonymous("spam"), { as: visitor(), headers: ownNetwork() });
    expect(spam.body.priority).toBe("P2");
    const scam = await report(listingNotice(id, "scam"), { as: await member(), headers: ownNetwork() });
    expect(scam.body.priority).toBe("P1");
    // Same device and network as an open notice: nothing to corroborate.
    const { id: other } = await publishedListing();
    const network = ownNetwork();
    await report(listingNotice(other, "spam", { name: "Même Appareil", email: "meme-appareil@example.com" }), { as: visitor(), headers: network });
    const alone = await report(listingNotice(other, "misleading"), { as: await member(), headers: network });
    expect(alone.body.priority).toBe("P2");
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();
  });

  it("multi is off when the P0 limiters could not count (rate-limit store down)", async () => {
    const actual = await vi.importActual<typeof limiter>("@/lib/rate-limit/limiter");
    vi.mocked(limiter.consumeLimit).mockImplementation(async (id, key, points) => (id.startsWith("report.p0.") ? { ok: false, reason: "unavailable" } : actual.consumeLimit(id, key, points)));
    const { id } = await publishedListing();
    await report(listingNotice(id, "threat"), { as: await member(), headers: ownNetwork() });
    const second = await report(listingNotice(id, "threat"), { as: await member(), headers: ownNetwork() });
    expect(second.status).toBe(201);
    expect((await getReport(second.body.reportId))!.hidden).toBe(false);
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();
  });

  it("trusted: one P0 from a trusted reporter hides at once", async () => {
    const { id } = await publishedListing();
    const trusted = await member();
    await makeTrusted(trusted);
    expect(await isTrustedReporter(trusted.uid)).toBe(true);
    const result = await report(listingNotice(id, "minors"), { as: trusted, headers: ownNetwork() });
    expect((await getReport(result.body.reportId))!).toMatchObject({ strongSignal: "trusted", hidden: true, reporter: { trusted: true } });
    expect((await getListing(id))!.moderation.hiddenBy?.signal).toBe("trusted");
  });

  it("trusted flagger of config/ai: one P0 hides at once", async () => {
    const { id } = await publishedListing();
    const flagger = await member();
    await db().collection("config").doc("ai").set({ trustedFlaggers: [flagger.uid] });
    setAiConfigForTests(undefined);
    expect(await isTrustedReporter(flagger.uid)).toBe(true);
    const result = await report(listingNotice(id, "terrorism"), { as: flagger, headers: ownNetwork() });
    expect((await getReport(result.body.reportId))!.strongSignal).toBe("trusted");
    expect((await getListing(id))!.moderation.hiddenBy?.signal).toBe("trusted");
  });

  it("auto: a stored photo nudity score at or above reports.autoHideNsfwAt", async () => {
    const { id, uploadId } = await publishedListing();
    await updateUpload(uploadId, { checks: { nsfw: 0.97, faces: 0 } });
    const result = await report(listingNotice(id, "minors"), { as: visitor(), headers: ownNetwork() });
    expect((await getReport(result.body.reportId))!).toMatchObject({ strongSignal: "auto", hidden: true });
    expect((await getListing(id))!.moderation.hiddenBy?.signal).toBe("auto");
  });
});

describe("strong signals on accounts and messages", () => {
  it("restricts an account and hides its listings; unhideTarget restores both", async () => {
    const { id, seller } = await publishedListing();
    const trusted = await member();
    await makeTrusted(trusted);
    const publicId = await publicIdOf(seller.uid);
    const result = await report({ target: { type: "user", id: publicId }, reasonId: "threat", explanation: EXPLANATION, goodFaith: true }, { as: trusted, headers: ownNetwork() });
    expect(result.status).toBe(201);
    expect((await getReport(result.body.reportId))!).toMatchObject({ strongSignal: "trusted", hidden: true });
    const account = await db().collection(COLLECTIONS.users).doc(seller.uid).get();
    expect(account.get("status")).toBe("restricted");
    expect((await getListing(id))!.moderation.hiddenBy).toMatchObject({ reportId: result.body.reportId, signal: "trusted" });
    expect(await getPublicProfile(publicId)).toBeNull();
    expect(await auditActions(seller.uid)).toContain("user.restrict");

    expect(await unhideTarget({ type: "user", id: seller.uid })).toBe(true);
    expect((await db().collection(COLLECTIONS.users).doc(seller.uid).get()).get("status")).toBe("active");
    expect((await getListing(id))!.moderation.hiddenBy).toBeUndefined();
    expect((await getPublicProfile(publicId))?.listings.map((card) => card.id)).toContain(id);
  });

  it("hands a message to the messaging lot's hide", async () => {
    const hide = vi.mocked(hideMessage);
    hide.mockClear();
    hide.mockResolvedValueOnce(true);
    const { id, seller } = await publishedListing();
    const buyer = await member();
    await makeTrusted(buyer);
    const { cid, mid } = await seedConversation(id, buyer, seller, seller, "Je sais où tu habites.");
    const result = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "threat", explanation: EXPLANATION, goodFaith: true }, { as: buyer, headers: ownNetwork() });
    expect(result.status).toBe(201);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledWith(cid, mid, `report:${result.body.reportId}`);
    expect((await getReport(result.body.reportId))!.hidden).toBe(true);
  });

  it("with the messaging lot's own hide: text masked, original kept as evidence, restored by unhideTarget", async () => {
    const { id, seller } = await publishedListing();
    const buyer = await member();
    await makeTrusted(buyer);
    const text = "Je sais où tu habites, paie ou je viens.";
    const { cid, mid } = await seedConversation(id, buyer, seller, seller, text);
    const result = await report({ target: { type: "message", id: `${cid}/${mid}` }, reasonId: "threat", explanation: EXPLANATION, goodFaith: true }, { as: buyer, headers: ownNetwork() });
    expect(result.status).toBe(201);
    const conversation = db().collection(COLLECTIONS.conversations).doc(cid);
    const message = conversation.collection(COLLECTIONS.messages).doc(mid);
    expect((await message.get()).get("hidden")).toBe(true);
    expect((await message.get()).get("text")).not.toBe(text);
    expect((await conversation.collection(COLLECTIONS.evidence).doc(mid).get()).get("text")).toBe(text);
    expect((await conversation.get()).get("legalHold")).toContain(`report:${result.body.reportId}`);
    expect(await unhideTarget({ type: "message", id: `${cid}/${mid}` })).toBe(true);
    expect(vi.mocked(unhideMessage)).toHaveBeenCalledWith(cid, mid);
    expect((await message.get()).get("hidden")).toBeUndefined();
    expect((await message.get()).get("text")).toBe(text);
  });
});

describe("system and authority reports", () => {
  it("a system report never hides, asks for a triage, and deduplicates on its reason", async () => {
    const triage = vi.fn(async () => undefined);
    setTriageRequester(triage);
    const target = await member();
    const first = await createSystemReport({ target: { type: "user", id: target.uid }, reasonId: "scam", explanation: "3 messages signalés en 24 h dans 2 conversations.", source: "system" });
    expect(first).toMatchObject({ duplicate: false, priority: "P1", hidden: false });
    expect(triage).toHaveBeenCalledWith(first.reportId);
    const stored = (await getReport(first.reportId))!;
    expect(stored).toMatchObject({ source: "system", target: { type: "user", id: target.uid, ownerUid: target.uid, publicId: await publicIdOf(target.uid) }, reporter: { trusted: false } });
    const again = await createSystemReport({ target: { type: "user", id: target.uid }, reasonId: "scam", explanation: "Encore.", source: "system" });
    expect(again).toMatchObject({ reportId: first.reportId, duplicate: true });
    expect((await db().collection(COLLECTIONS.users).doc(target.uid).get()).get("status")).toBe("active");
  });

  it("an authority report hides at once (signal authority) and is never triaged", async () => {
    const triage = vi.fn(async () => undefined);
    setTriageRequester(triage);
    const { id } = await publishedListing();
    const result = await createSystemReport({ target: { type: "listing", id }, reasonId: "terrorism", explanation: "Injonction de retrait.", source: "authority", authorityRequestId: "AUTH123" });
    expect(result).toMatchObject({ priority: "P0", hidden: true, duplicate: false });
    expect(triage).not.toHaveBeenCalled();
    expect((await getReport(result.reportId))!).toMatchObject({ source: "authority", strongSignal: "authority", authorityRequestId: "AUTH123", reporter: { trusted: true } });
    expect((await getListing(id))!.moderation.hiddenBy).toMatchObject({ signal: "authority", reportId: result.reportId });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect((await createSystemReport({ target: { type: "listing", id }, reasonId: "terrorism", explanation: "Retry.", source: "authority", authorityRequestId: "AUTH123" })).duplicate).toBe(true);
  });
});

describe("decision helpers (L3)", () => {
  it("closeReportsTx closes the reports of a target; recordReporterOutcomes applies art. 23", async () => {
    const { id } = await publishedListing();
    const reporters: Member[] = [await member(), await member()];
    const ids: string[] = [];
    for (const who of reporters) ids.push((await report(listingNotice(id, "misleading"), { as: who, headers: ownNetwork() })).body.reportId);
    expect((await openReportsForTarget(targetKey({ type: "listing", id }))).map((item) => item.id).sort()).toEqual([...ids].sort());

    const now = new Date();
    await db().runTransaction(async (tx) => {
      closeReportsTx(tx, ids, { status: "dismissed", outcome: "unfounded", decisionId: "DEC1", manifestlyUnfounded: [ids[0]!], now });
    });
    const [flagged, plain] = [(await getReport(ids[0]!))!, (await getReport(ids[1]!))!];
    expect(flagged).toMatchObject({ status: "dismissed", outcome: "unfounded", decisionId: "DEC1", manifestlyUnfounded: true });
    expect(plain.manifestlyUnfounded).toBeUndefined();
    expect(plain.closedAt?.getTime()).toBe(now.getTime());
    expect(await openReportsForTarget(targetKey({ type: "listing", id }))).toEqual([]);

    const abuser = reporters[0]!;
    const outcome = { uid: abuser.uid, founded: false, manifestlyUnfounded: true };
    expect(await recordReporterOutcomes([outcome, { uid: reporters[1]!.uid, founded: true }])).toEqual({ warned: [], suspended: [] });
    expect(await recordReporterOutcomes([outcome])).toEqual({ warned: [], suspended: [] });
    expect(await recordReporterOutcomes([outcome])).toEqual({ warned: [abuser.uid], suspended: [] });
    expect(await recordReporterOutcomes([outcome])).toEqual({ warned: [], suspended: [abuser.uid] });
    const refused = await report(listingNotice(id, "spam"), { as: abuser, headers: ownNetwork() });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("report_not_allowed");
    expect(await auditActions(abuser.uid)).toEqual(expect.arrayContaining(["reporter.warn", "reporter.suspend"]));

    const account = await db().collection(COLLECTIONS.users).doc(reporters[1]!.uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).get();
    expect(account.get("reporter")).toMatchObject({ recent: [true], total: 1 });
  });
});
