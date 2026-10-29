import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async (token: string | undefined) => (token === "bad" ? { ok: false, codes: ["invalid-input-response"] } : { ok: true, codes: [] })),
}));

import { GET as exportRoute } from "@/app/api/account/export/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { AccountExport } from "@/lib/contracts/account";
import { ACCOUNT_API } from "@/lib/contracts/endpoints";
import { URL_MARKER } from "@/lib/contracts/messaging";
import { proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { emailNormHash } from "@/lib/db/repositories/users";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setEventPublisherForTests } from "@/lib/messaging/events";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { call, expectError, type ErrorBody } from "../favorites/helpers";
import { member, seedListing, send, startOk, type Member } from "../messaging/helpers";

// GET /api/account/export on the emulators (phase 5 D26, lot L7): who may download (session, CSRF
// header, three a day), the file (attachment, never cached), what it holds (profile, account,
// listings, favorites, saved searches, conversations as stored, reports filed and the caller's own
// appeal, decisions about the caller, blocked accounts) and what it never holds: another member's
// private data, a report about the caller, a masked message's original, staff fields (moderator
// and reviewer ids, AI proposals, report fingerprints, KYBC checks, legal holds).

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  setEventPublisherForTests(async () => undefined);
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setEventPublisherForTests(undefined);
});

type ExportBody = AccountExport & ErrorBody;
const download = (who: Member | undefined, options: { csrf?: boolean } = {}) => call<ExportBody>(exportRoute, "GET", ACCOUNT_API.export, { member: who, ...options });

/** The uid as a whole token (a test uid can be the prefix of another one). */
const uidPattern = (uid: string) => new RegExp(`${uid}(?![0-9])`);

const at = (offsetMs = 0) => Timestamp.fromMillis(Date.now() + offsetMs);

function reportDoc(reporter: Member, target: { type: "listing" | "user"; id: string; ownerUid: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target,
    reasonId: "scam",
    priority: "P2",
    explanation: "Le vendeur demande une avance par Wafacash.",
    goodFaith: true,
    source: "user",
    reporter: { uid: reporter.uid, name: "Salma B.", email: reporter.email, locale: "fr", ipPrefixHash: "iphash-staff-only", deviceHash: "devhash-staff-only", trusted: false },
    hidden: false,
    status: "open",
    slaDueAt: at(DAY_MS),
    createdAt: at(),
    updatedAt: at(),
    purgeAt: at(5 * YEAR_MS),
    ...extra,
  };
}

function decisionDoc(affectedUid: string, target: { type: string; id: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target,
    affectedUid,
    action: "warn",
    facts: "Annonce signalée pour demande d'avance.",
    origin: "notice",
    automation: { detection: false, decision: false },
    ground: { type: "terms", ref: "CGU §7.2", explanation: "Demande de paiement hors plateforme." },
    reportIds: ["report-staff-only"],
    templateId: "warn_scam",
    decidedBy: "moderator-staff-only",
    aiDecisionId: "ai-proposal-staff-only",
    notifiedAt: at(),
    appealDeadline: at(180 * DAY_MS),
    createdAt: at(),
    purgeAt: at(5 * YEAR_MS),
    ...extra,
  };
}

describe("GET /api/account/export: who may download", () => {
  it("needs a session and the CSRF header", async () => {
    const who = await member();
    expectError(await download(undefined), 401, "unauthenticated");
    expectError(await download(who, { csrf: false }), 403, "csrf");
  });

  it("allows three downloads a day per account", async () => {
    const who = await member();
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await download(who)).status).toBe(200);
    expectError(await download(who), 429, "rate_limited");
  });
});

describe("GET /api/account/export: the file", () => {
  it("holds the member's own data, as an attachment never cached", async () => {
    const [me, other] = await Promise.all([member({ displayName: "Salma Exportée" }), member({ displayName: "Karim Autre" })]);
    const mine = await seedListing(me);
    const sold = await seedListing(me, { status: "sold", title: "Table basse en cèdre" });
    const theirs = await seedListing(other, { title: "Vélo du voisin" });

    // A conversation about the other member's listing: the reply's link is masked, its original kept as evidence.
    const { cid } = await startOk(me, theirs.id, "Bonjour, toujours disponible ?");
    const masked = await send(other, cid, "Payez l'acompte ici https://paiement-securise.example.com/x et appelez 0612345678");
    expect(masked.status).toBe(201);

    const users = db().collection(COLLECTIONS.users);
    await users.doc(me.uid).collection(COLLECTIONS.favorites).doc(theirs.id).set({
      createdAt: at(),
      listingSnapshot: { slugId: theirs.slugId, title: "Vélo du voisin", subcategoryId: "velos", price: 1500, priceNegotiable: true, isDonation: false, citySlug: "casablanca", photo: null, photoCount: 1, sellerType: "individual" },
    });
    await users.doc(me.uid).collection(COLLECTIONS.savedSearches).doc("s1").set({ name: "Vélos à Casa", params: { q: "velo", city: "casablanca" }, alert: "daily", lastNotifiedSortAt: 0, createdAt: at(), updatedAt: at() });
    await db().collection(COLLECTIONS.userBlocks).doc(me.uid).set({ uids: [other.uid], updatedAt: at() });
    await users.doc(me.uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc).update({ legalHold: ["authority:hold-staff-only"] });

    // A Pro profile with the moderators' checks on it.
    const proId = "exprtprz";
    await users.doc(me.uid).update({ proId });
    const now = new Date();
    await db()
      .collection(COLLECTIONS.proProfiles)
      .doc(proId)
      .set(
        proProfileToFirestore({
          ownerUid: me.uid,
          members: { [me.uid]: "owner" },
          name: "Atlas Meubles",
          slug: "atlas-meubles-casablanca",
          description: "Meubles en cèdre.",
          whatsapp: false,
          regionCode: "06",
          citySlug: "casablanca",
          legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
          kybc: {
            status: "verified",
            iceFormatOk: true,
            registryCheck: { source: "ompic", at: now, by: "kyb-checker-staff-only" },
            uploadIds: ["kyb-piece-staff-only"],
            phoneCheck: { at: now, by: "phone-checker-staff-only", outcome: "verified", phone: "+212612345678", note: "Note interne staff-only" },
            submittedAt: now,
            decisionId: "kyb-decision-staff-only",
          },
          lifecycle: "verified",
          plan: "essentiel",
          planSource: "launch_offer",
          quotas: DEFAULT_PRICING.pro.essentiel,
          createdAt: now,
          updatedAt: now,
        }),
      );

    // A report the member filed, closed by a decision about the other member, and the member's own appeal on it.
    const filed = db().collection(COLLECTIONS.reports).doc();
    const aboutOther = db().collection(COLLECTIONS.moderationDecisions).doc();
    await filed.set(reportDoc(me, { type: "listing", id: theirs.id, ownerUid: other.uid }, { status: "dismissed", outcome: "unfounded", decisionId: aboutOther.id, assignee: "assignee-staff-only", aiDecisionId: "ai-triage-staff-only", closedAt: at() }));
    await aboutOther.set(
      decisionDoc(other.uid, { type: "listing", id: theirs.id }, { action: "no_action", appeal: { status: "upheld", by: "reporter", reportId: filed.id, text: "Je maintiens mon signalement.", openedAt: at(), closedAt: at(), reviewer: "reviewer-staff-only", note: "Aucun élément nouveau." } }),
    );
    // A report about the member by the other one, and the decision it led to (the member appealed).
    const aboutMe = db().collection(COLLECTIONS.reports).doc();
    await aboutMe.set(reportDoc(other, { type: "user", id: me.uid, ownerUid: me.uid }, { explanation: "Signalement du voisin, confidentiel." }));
    const decision = db().collection(COLLECTIONS.moderationDecisions).doc();
    await decision.set(decisionDoc(me.uid, { type: "listing", id: mine.id }, { appeal: { status: "open", by: "affected", text: "Mon annonce est conforme.", openedAt: at(), reviewer: "reviewer-staff-only" } }));

    const result = await download(me);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.header("content-type")).toBe("application/json; charset=utf-8");
    expect(result.header("content-disposition")).toMatch(/^attachment; filename="aalan-mes-donnees-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(result.header("cache-control")).toBe("no-store");
    expect(result.header("x-content-type-options")).toBe("nosniff");

    const file = result.body;
    expect(file).toMatchObject({ format: "joutiya.account-export", truncated: {} });
    expect(file.about.length).toBeGreaterThan(0);
    expect(file.profile).toMatchObject({ displayName: "Salma Exportée", status: "active" });
    expect(file.account).toMatchObject({ email: me.email, providers: ["password"], consents: { marketing: false } });
    expect(file.pro).toMatchObject({ name: "Atlas Meubles", verification: { status: "verified", pieces: 1, phoneCheck: { outcome: "verified", phone: "+212612345678" } } });
    expect(file.listings.map((listing) => listing.id).sort()).toEqual([mine.id, sold.id].sort());
    expect(file.listings.find((listing) => listing.id === sold.id)).toMatchObject({ status: "sold", title: "Table basse en cèdre" });
    expect(file.favorites).toEqual([expect.objectContaining({ listingId: theirs.id, title: "Vélo du voisin" })]);
    expect(file.savedSearches).toEqual([expect.objectContaining({ name: "Vélos à Casa", alert: "daily" })]);
    expect(file.blockedAccounts).toEqual([{ publicId: expect.any(String), displayName: "Karim Autre" }]);

    expect(file.conversations).toHaveLength(1);
    const [conversation] = file.conversations;
    expect(conversation).toMatchObject({ cid, role: "buyer", counterpart: { displayName: "Karim Autre" }, messagesTruncated: false });
    expect(conversation!.messages.map((message) => [message.mine, message.text])).toEqual([
      [true, "Bonjour, toujours disponible ?"],
      [false, `Payez l'acompte ici ${URL_MARKER} et appelez 0612345678`],
    ]);
    expect(conversation!.messages[1]!.flags).toContain("external_url");

    expect(file.reportsFiled).toEqual([
      expect.objectContaining({
        id: filed.id,
        target: { type: "listing", listingId: theirs.id, publicId: null },
        status: "dismissed",
        outcome: "unfounded",
        reporter: { name: "Salma B.", email: me.email, locale: "fr" },
        appeal: expect.objectContaining({ status: "upheld", text: "Je maintiens mon signalement.", note: "Aucun élément nouveau." }),
      }),
    ]);
    expect(file.decisions).toEqual([
      expect.objectContaining({ decisionId: decision.id, action: "warn", appeal: expect.objectContaining({ status: "open", text: "Mon annonce est conforme.", note: null }) }),
    ]);

    // Never: the other member's private data, a report about the member, a masked original, a staff field.
    const text = JSON.stringify(file);
    expect(text).not.toMatch(uidPattern(other.uid));
    expect(text).not.toContain(other.email);
    expect(text).not.toContain(aboutMe.id);
    expect(text).not.toContain("Signalement du voisin");
    expect(text).not.toContain("paiement-securise.example.com");
    expect(text).not.toContain(emailNormHash(me.email));
    for (const field of ["emailNormHash", "legalHold", "decidedBy", "reportIds", "aiDecisionId", "reviewer", "assignee", "ipPrefixHash", "deviceHash", "registryCheck", "iceFormatOk", "purgeAt"]) {
      expect(text, field).not.toContain(`"${field}"`);
    }
    expect(text).not.toContain("staff-only");

    await Promise.all([filed.delete(), aboutOther.delete(), aboutMe.delete(), decision.delete(), db().collection(COLLECTIONS.proProfiles).doc(proId).delete()]);
  });
});
