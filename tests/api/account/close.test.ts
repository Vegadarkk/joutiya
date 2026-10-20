import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AccountContracts from "@/lib/contracts/account";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

const recent = vi.hoisted(() => ({ seconds: 600 }));

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async (token: string | undefined) => (token === "bad" ? { ok: false, codes: ["invalid-input-response"] } : { ok: true, codes: [] })),
}));
// The recent sign-in window, shrunk by one test to refuse a session minted seconds ago.
vi.mock("@/lib/contracts/account", async (importOriginal) => {
  const actual = await importOriginal<typeof AccountContracts>();
  return {
    ...actual,
    get RECENT_AUTH_SECONDS() {
      return recent.seconds;
    },
  };
});

import { POST as closeRoute } from "@/app/api/account/close/route";
import { GET as exportRoute } from "@/app/api/account/export/route";
import { closeAccount } from "@/lib/account/close";
import { ACCOUNT_API } from "@/lib/contracts/endpoints";
import type { CloseAccountResponse } from "@/lib/contracts/account";
import { COLLECTIONS } from "@/lib/db/schemas";
import { emailNormHash } from "@/lib/db/repositories/users";
import { auth, db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import { setEventPublisherForTests, type Delivery } from "@/lib/messaging/events";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { Jar } from "../auth/helpers";
import { call, expectError, type ErrorBody } from "../favorites/helpers";
import { member, row, seedListing, send, startOk, thread, type Member } from "../messaging/helpers";

// POST /api/account/close on the emulators (phase 5 D26, lot L7): who may close (session, CSRF,
// recent sign-in, Pro refusal), what the closure does (closure dates, status, Auth disabled and
// revoked, listings removed with their search delete, conversations read-only for the other
// participant, favorites and saved searches deleted, audit, mail, live streams closed), what it
// keeps (reports, decisions, suspension, strikes, legal holds, the e-mail index), and that a retry
// after a failure half-way keeps the first attempt's dates.

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let events: Delivery[] = [];

beforeEach(() => {
  resetRateLimiters();
  recent.seconds = 600;
  setMessagingValkeyForTests(new FakeValkey().asClient());
  vi.mocked(firstDegraded).mockResolvedValue(null);
  vi.mocked(sendMail).mockClear();
  events = [];
  setEventPublisherForTests(async (deliveries) => {
    events.push(...deliveries);
  });
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setEventPublisherForTests(undefined);
});

type CloseBody = CloseAccountResponse & ErrorBody;
const close = (who: Member, body: unknown = { confirm: true }, options: { csrf?: boolean } = {}) => call<CloseBody>(closeRoute, "POST", ACCOUNT_API.close, { member: who, body, ...options });

const userDoc = async (uid: string) => (await db().collection(COLLECTIONS.users).doc(uid).get()).data()!;
const privateRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);
const privateDoc = async (uid: string) => (await privateRef(uid).get()).data()!;
const listingDoc = async (id: string) => (await db().collection(COLLECTIONS.listings).doc(id).get()).data()!;
const exists = async (path: string) => (await db().doc(path).get()).exists;
const millis = (value: unknown) => (value as Timestamp).toMillis();

/** A member whose claims changed (the old session is revoked by setClaims). */
async function withClaims(who: Member, claims: Parameters<typeof setClaims>[1]): Promise<Member> {
  await setClaims(who.uid, claims);
  const minted = await createSessionForUid(who.uid);
  who.jar.cookies.set("__Host-session", minted.cookie);
  who.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return who;
}

async function seedFavorite(who: Member, listingId: string): Promise<void> {
  await db()
    .collection(COLLECTIONS.users)
    .doc(who.uid)
    .collection(COLLECTIONS.favorites)
    .doc(listingId)
    .set({
      createdAt: Timestamp.now(),
      listingSnapshot: { slugId: `velo-${listingId}`, title: "Vélo", subcategoryId: "velos", price: 1500, priceNegotiable: true, isDonation: false, citySlug: "casablanca", photo: null, photoCount: 1, sellerType: "individual" },
    });
}

async function seedSavedSearch(who: Member): Promise<void> {
  const now = Timestamp.now();
  await db().collection(COLLECTIONS.users).doc(who.uid).collection(COLLECTIONS.savedSearches).doc("s1").set({ name: "Vélos à Casa", params: { q: "velo", city: "casablanca" }, alert: "daily", lastNotifiedSortAt: 0, createdAt: now, updatedAt: now });
}

describe("POST /api/account/close: who may close", () => {
  it("needs a session, the CSRF header and the explicit confirmation", async () => {
    const who = await member();
    expectError(await call(closeRoute, "POST", ACCOUNT_API.close, { body: { confirm: true } }), 401, "unauthenticated");
    expectError(await close(who, { confirm: true }, { csrf: false }), 403, "csrf");
    expectError(await close(who, {}), 400, "invalid_body");
    expectError(await close(who, { confirm: false }), 400, "invalid_body");
    expect((await userDoc(who.uid)).status).toBe("active");
  });

  it("asks for a recent sign-in (403 recent_auth_required) and changes nothing", async () => {
    const who = await member();
    const { id } = await seedListing(who);
    recent.seconds = -120;
    expectError(await close(who), 403, "recent_auth_required");
    expect((await userDoc(who.uid)).status).toBe("active");
    expect((await privateDoc(who.uid)).closedAt).toBeUndefined();
    expect((await listingDoc(id)).status).toBe("published");
    expect((await auth().getUser(who.uid)).disabled).toBe(false);
  });

  it("refuses while a Pro subscription renews or purchased credits are left (409), before any change", async () => {
    const who = await member();
    const proId = "abcdefgh";
    await db().collection(COLLECTIONS.users).doc(who.uid).update({ proId });
    await db().collection(COLLECTIONS.proProfiles).doc(proId).set({ ownerUid: who.uid, planSource: "subscription", lifecycle: "active" });
    expectError(await close(who), 409, "pro_subscription_active");

    await db().collection(COLLECTIONS.proProfiles).doc(proId).set({ ownerUid: who.uid, planSource: "launch_offer", lifecycle: "active" });
    await db().collection("subscriptions").doc(`pro_${proId}`).set({ status: "grace", willRenew: true });
    expectError(await close(who), 409, "pro_subscription_active");

    // Cancelled: it runs out on its own; purchased credits still block.
    await db().collection("subscriptions").doc(`pro_${proId}`).set({ status: "cancelled", willRenew: false });
    await db().collection("wallets").doc(who.uid).set({ balance: 30, frozen: false, planCredits: 0 });
    expectError(await close(who), 409, "wallet_not_empty");

    expect((await userDoc(who.uid)).status).toBe("active");
    expect((await privateDoc(who.uid)).closedAt).toBeUndefined();
    expect((await auth().getUser(who.uid)).disabled).toBe(false);

    await db().collection("wallets").doc(who.uid).set({ balance: 0, frozen: false, planCredits: 40 });
    expect((await close(who)).status).toBe(200);
    await db().collection(COLLECTIONS.proProfiles).doc(proId).delete();
    await db().collection("subscriptions").doc(`pro_${proId}`).delete();
    await db().collection("wallets").doc(who.uid).delete();
  });

  it("is rate limited per account", async () => {
    const who = await member();
    recent.seconds = -120;
    for (let attempt = 0; attempt < 5; attempt += 1) expectError(await close(who), 403, "recent_auth_required");
    expectError(await close(who), 429, "rate_limited");
  });
});

describe("POST /api/account/close: effects", () => {
  it("closes the account: dates, status, Auth, listings, conversations, favorites, saved searches, audit, mail, streams", async () => {
    const [seller, buyer] = await Promise.all([member({ displayName: "Salma Vendeuse" }), member({ displayName: "Youssef Acheteur" })]);
    const published = await seedListing(seller);
    const paused = await seedListing(seller, { status: "paused", pausedReason: "owner" });
    const draft = await seedListing(seller, { status: "draft" });
    const soldPurge = new Date(Date.now() + 30 * DAY_MS);
    const sold = await seedListing(seller, { status: "sold", purgeAt: soldPurge });
    const other = await seedListing(buyer);
    const { cid } = await startOk(buyer, published.id);
    expect((await send(seller, cid, "Oui, toujours disponible.")).status).toBe(201);
    await seedFavorite(seller, other.id);
    await seedSavedSearch(seller);
    await privateRef(seller.uid).update({ legalHold: ["report:r-close-1"], "strikes.level": 1 });
    // A report about the seller and a decision about it: the closure leaves both alone.
    const reportRef = db().collection(COLLECTIONS.reports).doc();
    await reportRef.set({ target: { type: "user", id: seller.uid, ownerUid: seller.uid }, status: "open", createdAt: Timestamp.now() });
    const decisionRef = db().collection(COLLECTIONS.moderationDecisions).doc();
    await decisionRef.set({ affectedUid: seller.uid, action: "warn", createdAt: Timestamp.now() });
    const session = seller.jar.cookies.get("__Host-session")!;

    const before = Date.now();
    const result = await close(seller);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.status).toBe("closed");
    expect(result.header("cache-control")).toBe("no-store");
    // The session cookies are cleared in the answer.
    expect(seller.jar.get("__Host-session")).toBeUndefined();
    const closedAt = Date.parse(result.body.closedAt);
    expect(closedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(result.body.purgeAt) - closedAt).toBeGreaterThanOrEqual(YEAR_MS);

    const account = await privateDoc(seller.uid);
    expect(millis(account.closedAt)).toBe(closedAt);
    expect(millis(account.purgeAt)).toBe(Date.parse(result.body.purgeAt));
    expect(new Date(millis(account.identityPurgeAt)).getUTCFullYear()).toBe(new Date(closedAt).getUTCFullYear() + 5);
    // Kept as they were: holds, strikes, the e-mail (purged in a year), and the e-mail index.
    expect(account.legalHold).toEqual(["report:r-close-1"]);
    expect(account.strikes.level).toBe(1);
    expect(account.email).toBe(seller.email);
    expect(await exists(`${COLLECTIONS.emailIndex}/${emailNormHash(seller.email)}`)).toBe(true);
    expect((await userDoc(seller.uid)).status).toBe("closed");

    const record = await auth().getUser(seller.uid);
    expect(record.disabled).toBe(true);
    expect(record.tokensValidAfterTime).toBeDefined();
    // The old session no longer opens anything.
    const stale: Member = { ...seller, jar: new Jar() };
    stale.jar.cookies.set("__Host-session", session);
    stale.jar.cookies.set("__Host-csrf", csrfToken(session));
    expectError(await call(exportRoute, "GET", ACCOUNT_API.export, { member: stale }), 401, "unauthenticated");

    // Listings: live, paused and sold ones removed (sold keeps its earlier purge date), the draft kept.
    const removed = await listingDoc(published.id);
    expect(removed.status).toBe("removed");
    expect(millis(removed.purgeAt) - Date.now()).toBeGreaterThan(300 * DAY_MS);
    expect((await db().collection(COLLECTIONS.searchOutbox).doc(published.id).get()).get("op")).toBe("delete");
    expect((await listingDoc(paused.id)).status).toBe("removed");
    const soldNow = await listingDoc(sold.id);
    expect(soldNow.status).toBe("removed");
    expect(millis(soldNow.purgeAt)).toBe(soldPurge.getTime());
    expect((await listingDoc(draft.id)).status).toBe("draft");
    expect((await listingDoc(other.id)).status).toBe("published");

    // The buyer still reads the conversation, nobody writes in it.
    const conversation = (await db().collection(COLLECTIONS.conversations).doc(cid).get()).data()!;
    expect(conversation.accountClosed).toEqual([seller.uid]);
    const view = await row(buyer, cid);
    expect(view.status).toBe(200);
    expect(view.body.conversation).toMatchObject({ counterpartClosed: true, blockedMe: false });
    const messages = await thread(buyer, cid);
    expect(messages.status).toBe(200);
    expect(messages.body.messages.map((message) => message.text)).toContain("Oui, toujours disponible.");
    expectError(await send(buyer, cid, "Vous êtes là ?"), 409, "conversation_unavailable");
    expect(events).toContainEqual({ uid: buyer.uid, event: expect.objectContaining({ type: "conversation", cid }) });
    expect(events).toContainEqual({ uid: seller.uid, event: { type: "revoked" } });

    // Favorites and saved searches deleted; reports and decisions untouched.
    expect((await db().collection(COLLECTIONS.users).doc(seller.uid).collection(COLLECTIONS.favorites).get()).size).toBe(0);
    expect((await db().collection(COLLECTIONS.users).doc(seller.uid).collection(COLLECTIONS.savedSearches).get()).size).toBe(0);
    expect((await reportRef.get()).get("status")).toBe("open");
    expect((await decisionRef.get()).exists).toBe(true);

    const audits = await db().collection(COLLECTIONS.auditLogs).where("target.id", "==", seller.uid).where("action", "==", "account.close").get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.get("reason")).toContain("3 listing(s) removed");

    const mails = vi.mocked(sendMail).mock.calls.map(([mail]) => mail);
    expect(mails).toContainEqual(expect.objectContaining({ template: "accountClosed", to: seller.email, priority: "transactional", data: expect.objectContaining({ displayName: "Salma Vendeuse", closedAt: result.body.closedAt, purgeAt: result.body.purgeAt }) }));

    // Closed: no new conversation with the seller either (the listing is gone, the account unreachable).
    await reportRef.delete();
    await decisionRef.delete();
  });

  it("keeps a suspension, its strikes and the ban that follows a closure's status", async () => {
    const who = await member();
    const until = new Date(Date.now() + 7 * DAY_MS);
    await db().collection(COLLECTIONS.suspensions).doc(who.uid).set({ until: Timestamp.fromDate(until), decisionId: "d-susp-1", createdAt: Timestamp.now() });
    await db().collection(COLLECTIONS.users).doc(who.uid).update({ status: "suspended" });
    await privateRef(who.uid).update({ "strikes.level": 2, "strikes.suspendedUntil": Timestamp.fromDate(until) });
    await withClaims(who, { role: "individual", st: "suspended" });

    expect((await close(who)).status).toBe(200);
    expect((await userDoc(who.uid)).status).toBe("closed");
    expect(await exists(`${COLLECTIONS.suspensions}/${who.uid}`)).toBe(true);
    const account = await privateDoc(who.uid);
    expect(account.strikes.level).toBe(2);
    expect(millis(account.strikes.suspendedUntil)).toBe(until.getTime());
    expect((await auth().getUser(who.uid)).customClaims).toMatchObject({ st: "suspended" });
    await db().collection(COLLECTIONS.suspensions).doc(who.uid).delete();

    // A banned account stays banned (its ban is what blocks a new sign-up with the address).
    const banned = await member();
    await db().collection(COLLECTIONS.users).doc(banned.uid).update({ status: "banned" });
    await closeAccount(banned.uid);
    expect((await userDoc(banned.uid)).status).toBe("banned");
    expect((await privateDoc(banned.uid)).closedAt).toBeDefined();
  });
});

describe("POST /api/account/close: idempotence", () => {
  it("a retry after a failure half-way keeps the first attempt's dates and finishes the job", async () => {
    const who = await member();
    const { id } = await seedListing(who);
    // The first attempt wrote the dates and the status, then failed before the listings.
    const first = new Date(Date.now() - 60_000);
    const purgeAt = new Date(first.getTime() + YEAR_MS);
    const identityPurgeAt = new Date(first.getTime() + 5 * YEAR_MS);
    await privateRef(who.uid).update({ closedAt: Timestamp.fromDate(first), purgeAt: Timestamp.fromDate(purgeAt), identityPurgeAt: Timestamp.fromDate(identityPurgeAt) });
    await db().collection(COLLECTIONS.users).doc(who.uid).update({ status: "closed" });
    // A subscription bought meanwhile does not block the end of a closure already begun.
    await db().collection("subscriptions").doc(who.uid).set({ status: "active", willRenew: true });

    const retry = await close(who);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toEqual({ status: "closed", closedAt: first.toISOString(), purgeAt: purgeAt.toISOString() });
    expect((await listingDoc(id)).status).toBe("removed");
    expect((await auth().getUser(who.uid)).disabled).toBe(true);
    // The browser's cookies are gone: the same call again is anonymous.
    expectError(await close(who), 401, "unauthenticated");

    const again = await closeAccount(who.uid);
    expect(again).toMatchObject({ already: true, listings: 0, closedAt: first, purgeAt, identityPurgeAt });
    expect(millis((await privateDoc(who.uid)).closedAt)).toBe(first.getTime());
    await db().collection("subscriptions").doc(who.uid).delete();
  });
});
