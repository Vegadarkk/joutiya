import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { HIDDEN_MARKER, INBOX_PAGE, THREAD_PAGE, URL_MARKER } from "@/lib/contracts/messaging";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { newListingId } from "@/lib/listings/ids";
import { conversationId, freezeConversation, hideMessage } from "@/lib/messaging";
import { conversationRef, messagesRef } from "@/lib/messaging/repository";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { limitState, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { Jar } from "../auth/helpers";
import { expectError, inbox, markRead, member, row, seedListing, send, setState, spend, startOk, thread, type Member } from "./helpers";

// The read API of the messaging (design D2 revised 19 Oct: the browser never reads Firestore):
// the inbox pages, one inbox row and the thread pages with opaque cursors, newer-only reads,
// participants only (404 otherwise), deleted-for-me and archived conversations (D7), hidden
// messages, suspended accounts reading (D9), revoked sessions, the limiters and the quota gate.

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

afterAll(() => setMessagingValkeyForTests(undefined));

const MINUTE = 60_000;
/** Revocation is second-granular: a session minted in the same second as the revocation survives it. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

async function pair(): Promise<{ buyer: Member; seller: Member; listingId: string; cid: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id } = await seedListing(seller);
  const { cid } = await startOk(buyer, id);
  return { buyer, seller, listingId: id, cid };
}

/** `count` copies of `cid` for the same pair (other listings), each `MINUTE` older than the previous. */
async function seedConversations(cid: string, buyerUid: string, count: number): Promise<string[]> {
  const template = (await conversationRef(cid).get()).data()!;
  const base = Date.now() - 10 * MINUTE;
  const batch = db().batch();
  const cids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const listingId = newListingId();
    const copy = conversationId(listingId, buyerUid);
    cids.push(copy);
    batch.set(conversationRef(copy), { ...template, listingId, ...datesToTimestamps({ updatedAt: new Date(base - index * MINUTE) }) });
  }
  await batch.commit();
  return cids;
}

/** `count` older messages in `cid` (from `senderUid`), one minute apart before the first one. */
async function seedMessages(cid: string, senderUid: string, participants: string[], count: number, newest: Date): Promise<string[]> {
  const batch = db().batch();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const ref = messagesRef(cid).doc();
    ids.push(ref.id);
    batch.set(ref, datesToTimestamps({ senderUid, participants, type: "text", text: `Message ${index}`, createdAt: new Date(newest.getTime() - (index + 1) * MINUTE) }) as Record<string, unknown>);
  }
  await batch.commit();
  return ids;
}

/** A member whose claims changed; returns the cookie of the revoked session too. */
async function withClaims(who: Member, claims: Parameters<typeof setClaims>[1]): Promise<{ who: Member; stale: Member }> {
  const stale: Member = { ...who, jar: new Jar(who.jar.ip) };
  for (const [name, value] of who.jar.cookies) stale.jar.cookies.set(name, value);
  await setClaims(who.uid, claims);
  const minted = await createSessionForUid(who.uid);
  who.jar.cookies.set("__Host-session", minted.cookie);
  who.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return { who, stale };
}

describe("GET /api/conversations", () => {
  it("pages the caller's inbox, newest activity first, 30 a page with an opaque cursor, and charges the documents read", async () => {
    const { buyer, seller, cid } = await pair();
    const copies = await seedConversations(cid, buyer.uid, 34);
    const stranger = await pair();

    const first = await inbox(buyer);
    expect(first.status).toBe(200);
    expect(first.body.conversations).toHaveLength(INBOX_PAGE);
    expect(first.body.conversations[0]).toMatchObject({
      cid,
      role: "buyer",
      counterpart: { displayName: "Salma Vendeuse" },
      listing: { title: "Vélo de ville Peugeot", price: 1500, isDonation: false },
      lastMessage: { preview: "Bonjour, toujours disponible ?", mine: true, flagged: false },
      unread: 0,
      archived: false,
      blockedByMe: false,
      blockedMe: false,
      frozen: false,
      counterpartClosed: false,
    });
    const times = first.body.conversations.map((item) => item.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(first.body.next).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await inbox(buyer, { cursor: first.body.next! });
    expect(second.body.conversations).toHaveLength(5);
    expect(second.body.next).toBeUndefined();
    const all = [...first.body.conversations, ...second.body.conversations].map((item) => item.cid);
    expect(new Set(all)).toEqual(new Set([cid, ...copies]));
    expect(all).not.toContain(stranger.cid);
    // 31 documents for the first page (one more to know a page follows), 5 for the second.
    expect((await limitState("conversation.docs.uid", buyer.uid))?.consumedPoints).toBe(36);

    const sellers = await inbox(seller);
    expect(sellers.body.conversations).toHaveLength(INBOX_PAGE);
    expect(sellers.body.conversations[0]).toMatchObject({ cid, role: "seller", counterpart: { displayName: "Youssef Acheteur" }, unread: 1, lastMessage: { mine: false } });
  });

  it("leaves out what I deleted, shows what I archived only in the archive, until a new message", async () => {
    const { buyer, seller, cid } = await pair();
    const other = await seedListing(seller, { title: "Casque vélo" });
    const second = await startOk(buyer, other.id);
    expect((await setState(buyer, cid, { hidden: true })).status).toBe(204);
    expect((await setState(buyer, second.cid, { archived: true })).status).toBe(204);

    expect((await inbox(buyer)).body.conversations).toEqual([]);
    expect((await inbox(buyer, { archived: "1" })).body.conversations.map((item) => [item.cid, item.archived])).toEqual([[second.cid, true]]);
    expectError(await row(buyer, cid), 404, "not_found");
    expectError(await thread(buyer, cid), 404, "not_found");
    // The other participant still sees both.
    expect((await inbox(seller)).body.conversations.map((item) => item.cid)).toEqual([second.cid, cid]);

    await send(seller, cid, "Toujours intéressé ?");
    await send(seller, second.cid, "Et le casque ?");
    expect((await inbox(buyer)).body.conversations.map((item) => item.cid)).toEqual([second.cid, cid]);
    expect((await inbox(buyer, { archived: "1" })).body.conversations).toEqual([]);
  });

  it("refuses a cursor it did not produce, or a message cursor", async () => {
    const { buyer, cid } = await pair();
    expectError(await inbox(buyer, { cursor: "bm90LWEtY3Vyc29y" }), 400, "invalid_body");
    expectError(await inbox(buyer, { cursor: "../../x" }), 400, "invalid_body");
    const { body } = await thread(buyer, cid);
    expectError(await inbox(buyer, { cursor: body.latest! }), 400, "invalid_body");
  });
});

describe("GET /api/conversations/{cid}", () => {
  it("answers the row to a participant, 404 to anyone else and to a malformed cid", async () => {
    const { buyer, seller, cid } = await pair();
    expect((await row(seller, cid)).body.conversation).toMatchObject({ cid, role: "seller", unread: 1 });
    await freezeConversation(cid, "authority:ar9", true);
    expect((await row(buyer, cid)).body.conversation).toMatchObject({ cid, frozen: true });
    await setState(seller, cid, { blocked: true });
    expect((await row(buyer, cid)).body.conversation).toMatchObject({ blockedByMe: false, blockedMe: true });
    expect((await row(seller, cid)).body.conversation).toMatchObject({ blockedByMe: true, blockedMe: false });
    expectError(await row(await member(), cid), 404, "not_found");
    expectError(await row(buyer, "not-a-cid"), 404, "not_found");
    expectError(await row(undefined, cid), 401, "unauthenticated");
    expect((await limitState("conversation.docs.uid", buyer.uid))?.consumedPoints).toBe(2);
  });
});

describe("GET /api/conversations/{cid}/messages", () => {
  it("pages a thread newest first, 50 a page, then reads only the newer messages after `latest`", async () => {
    const { buyer, seller, cid } = await pair();
    const first = (await thread(buyer, cid)).body.messages[0]!;
    const older = await seedMessages(cid, seller.uid, [buyer.uid, seller.uid], THREAD_PAGE + 4, new Date(first.createdAt));

    const page = await thread(buyer, cid);
    expect(page.status).toBe(200);
    expect(page.body.conversation).toMatchObject({ cid, role: "buyer" });
    expect(page.body.messages).toHaveLength(THREAD_PAGE);
    expect(page.body.messages[0]).toMatchObject({ id: first.id, mine: true, type: "text", text: "Bonjour, toujours disponible ?", flags: [], hidden: false, readAt: null });
    expect(page.body.messages[1]).toMatchObject({ id: older[0], mine: false, text: "Message 0" });
    expect(page.body.next).toBeDefined();
    expect(page.body.latest).toBeDefined();
    expect(page.body.gap).toBeUndefined();

    const rest = await thread(buyer, cid, { cursor: page.body.next! });
    expect(rest.body.messages.map((message) => message.id)).toEqual(older.slice(THREAD_PAGE - 1));
    expect(rest.body.next).toBeUndefined();
    expect(rest.body.latest).toBeUndefined();

    // Nothing new: an empty page that keeps the position (2 documents: the conversation + the empty query).
    resetRateLimiters();
    const idle = await thread(buyer, cid, { after: page.body.latest! });
    expect(idle.body).toMatchObject({ messages: [], latest: page.body.latest });
    expect((await limitState("conversation.docs.uid", buyer.uid))?.consumedPoints).toBe(2);

    const reply = await send(seller, cid, "Oui, toujours là. Voir https://evil.example/pay");
    const fresh = await thread(buyer, cid, { after: page.body.latest! });
    expect(fresh.body.messages).toEqual([expect.objectContaining({ id: reply.body.messageId, mine: false, text: `Oui, toujours là. Voir ${URL_MARKER}`, flags: ["external_url"] })]);
    expect(fresh.body.latest).not.toBe(page.body.latest);
    expect(fresh.body.next).toBeUndefined();
    expect((await thread(buyer, cid, { after: fresh.body.latest! })).body.messages).toEqual([]);
  });

  it("says `gap` when more than a page arrived after the position", async () => {
    const { buyer, seller, cid } = await pair();
    const { body } = await thread(buyer, cid);
    const batch = db().batch();
    const start = body.messages[0]!.createdAt;
    for (let index = 1; index <= THREAD_PAGE + 1; index += 1) {
      batch.set(messagesRef(cid).doc(), datesToTimestamps({ senderUid: seller.uid, participants: [buyer.uid, seller.uid], type: "text", text: `Nouveau ${index}`, createdAt: new Date(start + index * 1000) }) as Record<string, unknown>);
    }
    await batch.commit();
    const newer = await thread(buyer, cid, { after: body.latest! });
    expect(newer.body.messages).toHaveLength(THREAD_PAGE);
    expect(newer.body.messages[0]!.text).toBe(`Nouveau ${THREAD_PAGE + 1}`);
    expect(newer.body.gap).toBe(true);
  });

  it("keeps hidden messages in place with their marker, and shows the read receipt", async () => {
    const { buyer, seller, cid } = await pair();
    const reply = await send(seller, cid, "Payez d'abord");
    expect(await hideMessage(cid, reply.body.messageId, "report:r1")).toBe(true);
    await markRead(buyer, cid);
    const messages = (await thread(buyer, cid)).body.messages;
    expect(messages[0]).toMatchObject({ id: reply.body.messageId, text: HIDDEN_MARKER, hidden: true });
    expect(messages[0]!.readAt).toEqual(expect.any(Number));
    expect((await thread(seller, cid)).body.conversation.lastMessage.preview).toBe(HIDDEN_MARKER);
  });

  it("answers 404 to a non-participant, 400 to a foreign cursor or to both cursors", async () => {
    const { buyer, cid } = await pair();
    expectError(await thread(await member(), cid), 404, "not_found");
    expectError(await thread(buyer, "short"), 404, "not_found");
    const { body } = await thread(buyer, cid);
    expectError(await thread(buyer, cid, { cursor: body.latest!, after: body.latest! }), 400, "invalid_body");
    expectError(await thread(buyer, cid, { after: "AAAA" }), 400, "invalid_body");
  });
});

describe("who reads", () => {
  it("lets a suspended member read (inbox, row, thread) while every write stays 403 (D9)", async () => {
    const { buyer, seller, cid } = await pair();
    await withClaims(seller, { role: "individual", st: "suspended" });
    expect((await inbox(seller)).status).toBe(200);
    expect((await row(seller, cid)).status).toBe(200);
    expect((await thread(seller, cid)).body.messages).toHaveLength(1);
    expectError(await send(seller, cid, "Salam"), 403, "account_suspended");
    expect((await send(buyer, cid, "Vous êtes là ?")).status).toBe(201);
  });

  it("refuses revoked sessions (401) and staff accounts (403)", async () => {
    const { buyer, cid } = await pair();
    await nextSecond();
    const { stale } = await withClaims(buyer, { role: "individual" });
    expectError(await inbox(stale), 401, "unauthenticated");
    expectError(await row(stale, cid), 401, "unauthenticated");
    expectError(await thread(stale, cid), 401, "unauthenticated");
    expect((await inbox(buyer)).status).toBe(200);
    const { who: moderator } = await withClaims(await member(), { role: "moderator" });
    expectError(await inbox(moderator), 403, "role_missing");
    expectError(await thread(moderator, cid), 403, "role_missing");
  });

  it("limits calls and documents per account, and stops with the read quota (503)", async () => {
    const { buyer, cid } = await pair();
    await spend("conversation.read.uid", buyer.uid);
    expectError(await inbox(buyer), 429, "rate_limited");
    expectError(await thread(buyer, cid), 429, "rate_limited");
    resetRateLimiters();
    await spend("conversation.docs.uid", buyer.uid);
    expectError(await row(buyer, cid), 429, "rate_limited");
    resetRateLimiters();
    vi.mocked(firstDegraded).mockResolvedValue("firestore.reads");
    const refused = await inbox(buyer);
    expectError(refused, 503, "quota_exhausted");
    expect(Number(refused.header("retry-after"))).toBeGreaterThanOrEqual(60);
  });
});
