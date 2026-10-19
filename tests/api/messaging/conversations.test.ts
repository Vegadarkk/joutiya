import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async (token: string | undefined) => (token === "bad" ? { ok: false, codes: ["invalid-input-response"] } : { ok: true, codes: [] })),
}));

import { URL_MARKER, cidSchema } from "@/lib/contracts/messaging";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { conversationId, freezeConversation, setRepeatRiskReporter, type RepeatRiskReport } from "@/lib/messaging";
import { getConversation } from "@/lib/messaging/repository";
import { MESSAGING_KEYS, setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { expectError, markRead, member, send, setState, spend, start, startOk, seedListing, unread, type Member } from "./helpers";

// /api/conversations/** and /api/messages/unread on the emulators (design phase-5 D1-D9, D21):
// who may start and write, Turnstile on the first message, risk flags and masking with evidence,
// blocks, frozen conversations, read receipts, archive and delete-for-me, the unread badge in
// Valkey (fake) and the repeat-risk system report. Messages never leave the participants.

let valkey: FakeValkey;
const reports: RepeatRiskReport[] = [];

beforeEach(() => {
  resetRateLimiters();
  valkey = new FakeValkey();
  setMessagingValkeyForTests(valkey.asClient());
  vi.mocked(firstDegraded).mockResolvedValue(null);
  vi.mocked(verifyTurnstile).mockClear();
  reports.length = 0;
  setRepeatRiskReporter(async (input) => {
    reports.push(input);
  });
});

afterAll(() => setMessagingValkeyForTests(undefined));

const conversationDoc = async (cid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).get()).data()!;
const messageDoc = async (cid: string, mid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.messages).doc(mid).get()).data()!;
const evidenceDoc = async (cid: string, mid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.evidence).doc(mid).get()).data();

async function pair(): Promise<{ buyer: Member; seller: Member; listingId: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id } = await seedListing(seller);
  return { buyer, seller, listingId: id };
}

/** A member whose claims changed (the old session is revoked by setClaims). */
async function withClaims(who: Member, claims: Parameters<typeof setClaims>[1]): Promise<Member> {
  await setClaims(who.uid, claims);
  const minted = await createSessionForUid(who.uid);
  who.jar.cookies.set("__Host-session", minted.cookie);
  who.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return who;
}

describe("POST /api/conversations", () => {
  it("starts one conversation per (listing, buyer) with a deterministic cid, then appends to it", async () => {
    const { buyer, seller, listingId } = await pair();
    const first = await startOk(buyer, listingId);
    expect(first).toMatchObject({ cid: conversationId(listingId, buyer.uid), existing: false });
    expect(cidSchema.safeParse(first.cid).success).toBe(true);
    expect(vi.mocked(verifyTurnstile)).toHaveBeenCalledWith("ok", expect.objectContaining({ action: "message" }));

    const conversation = await getConversation(first.cid);
    expect(conversation).toMatchObject({
      listingId,
      sellerUid: seller.uid,
      buyerUid: buyer.uid,
      participants: [buyer.uid, seller.uid],
      sellerName: "Salma Vendeuse",
      buyerName: "Youssef Acheteur",
      listingSnapshot: { title: "Vélo de ville Peugeot", price: 1500, isDonation: false },
      lastMessage: { preview: "Bonjour, toujours disponible ?", senderUid: buyer.uid, flagged: false },
      unread: { [seller.uid]: 1, [buyer.uid]: 0 },
      blockedBy: [],
      status: "open",
      messageCount: 1,
      legalHold: [],
    });
    const months = (conversation!.purgeAt.getTime() - conversation!.updatedAt.getTime()) / (30.4 * 24 * 3600 * 1000);
    expect(months).toBeGreaterThan(11.8);
    expect(months).toBeLessThan(12.2);
    expect(await messageDoc(first.cid, first.messageId)).toMatchObject({ senderUid: buyer.uid, participants: [buyer.uid, seller.uid], type: "text", text: "Bonjour, toujours disponible ?" });
    // The seller's badge is not trusted yet (no rebuild): the digest is queued anyway.
    expect(await valkey.zscore(MESSAGING_KEYS.digest, seller.uid)).not.toBeNull();

    const again = await start(buyer, { listingId, text: "Je peux passer ce soir", turnstileToken: "ok" });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ cid: first.cid, existing: true });
    expect(await conversationDoc(first.cid)).toMatchObject({ messageCount: 2, unread: { [seller.uid]: 2 } });
  });

  it("refuses without a session, without CSRF, and with a failed Turnstile token (before any read)", async () => {
    const { buyer, listingId } = await pair();
    expectError(await start(undefined, { listingId, text: "Salam", turnstileToken: "ok" }), 401, "unauthenticated");
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }, { csrf: false }), 403, "csrf");
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }, { origin: "https://evil.example" }), 403, "origin");
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "bad" }), 403, "turnstile_failed");
    expectError(await start(buyer, { listingId, text: "Salam" }), 400, "invalid_body");
    expectError(await start(buyer, { listingId, text: `x ${URL_MARKER}`, turnstileToken: "ok" }), 400, "invalid_body");
    expectError(await start(buyer, { listingId, text: "x".repeat(2001), turnstileToken: "ok" }), 400, "invalid_body");
    expect(await getConversation(conversationId(listingId, buyer.uid))).toBeNull();
  });

  it("refuses the seller's own listing, unknown, paused and hidden listings, and unreachable sellers", async () => {
    const { buyer, seller, listingId } = await pair();
    expectError(await start(seller, { listingId, text: "Moi-même", turnstileToken: "ok" }), 409, "self_conversation");
    expectError(await start(buyer, { listingId: "zzzz2222", text: "Salam", turnstileToken: "ok" }), 404, "not_found");
    const draft = await seedListing(seller, { status: "draft" });
    expectError(await start(buyer, { listingId: draft.id, text: "Salam", turnstileToken: "ok" }), 404, "not_found");
    const paused = await seedListing(seller, { status: "paused", pausedReason: "owner" });
    expectError(await start(buyer, { listingId: paused.id, text: "Salam", turnstileToken: "ok" }), 409, "listing_unavailable");
    const hidden = await seedListing(seller, { moderation: { state: "auto_ok", score: 0, flags: [], openReports: 1, hiddenBy: { reportId: "r1", signal: "trusted", at: new Date() } } });
    expectError(await start(buyer, { listingId: hidden.id, text: "Salam", turnstileToken: "ok" }), 409, "listing_unavailable");

    await db().collection(COLLECTIONS.users).doc(seller.uid).update({ status: "suspended" });
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }), 409, "listing_unavailable");
    await db().collection(COLLECTIONS.users).doc(seller.uid).update({ status: "active" });
    expect((await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" })).status).toBe(201);
  });

  it("refuses suspended accounts and staff accounts", async () => {
    const { buyer, listingId } = await pair();
    await withClaims(buyer, { role: "individual", st: "suspended" });
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }), 403, "account_suspended");
    const staff = await withClaims(await member(), { role: "moderator" });
    expectError(await start(staff, { listingId, text: "Salam", turnstileToken: "ok" }), 403, "role_missing");
  });

  it("refuses when either account blocked the other", async () => {
    const { buyer, seller, listingId } = await pair();
    await db().collection(COLLECTIONS.userBlocks).doc(seller.uid).set({ uids: [buyer.uid], updatedAt: new Date() });
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }), 403, "conversation_blocked");
    await db().collection(COLLECTIONS.userBlocks).doc(seller.uid).delete();
    await db().collection(COLLECTIONS.userBlocks).doc(buyer.uid).set({ uids: [seller.uid], updatedAt: new Date() });
    expectError(await start(buyer, { listingId, text: "Salam", turnstileToken: "ok" }), 403, "conversation_blocked");
  });

  it("limits new conversations: 50 a day, 10 for accounts younger than 7 days; the quota gate answers 503", async () => {
    const seller = await member();
    const { id } = await seedListing(seller);
    const young = await member({ createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
    await spend("conversation.new.young.uid", young.uid);
    expectError(await start(young, { listingId: id, text: "Salam", turnstileToken: "ok" }), 429, "rate_limited");

    const old = await member();
    await spend("conversation.new.uid", old.uid);
    expectError(await start(old, { listingId: id, text: "Salam", turnstileToken: "ok" }), 429, "rate_limited");

    const other = await member();
    vi.mocked(verifyTurnstile).mockClear();
    vi.mocked(firstDegraded).mockResolvedValue("firestore.writes");
    expectError(await start(other, { listingId: id, text: "Salam", turnstileToken: "ok" }), 503, "quota_exhausted");
    expect(vi.mocked(verifyTurnstile)).not.toHaveBeenCalled();
  });
});

describe("POST /api/conversations/{cid}/messages", () => {
  it("lets both participants write; the recipient's count rises, archive and delete-for-me are lifted", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await setState(seller, cid, { archived: true });
    await setState(buyer, cid, { hidden: true });
    const reply = await send(seller, cid, "Oui, il est disponible.");
    expect(reply.status).toBe(201);
    expect(reply.body.flags).toEqual([]);
    expect(await conversationDoc(cid)).toMatchObject({ unread: { [buyer.uid]: 1, [seller.uid]: 1 }, archivedBy: [], hiddenFor: [], messageCount: 2, lastMessage: { senderUid: seller.uid, preview: "Oui, il est disponible." } });
  });

  it("answers 404 to a non-participant and to a malformed cid", async () => {
    const { buyer, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    const stranger = await member();
    expectError(await send(stranger, cid, "Coucou"), 404, "not_found");
    expectError(await send(buyer, "not-a-cid", "Coucou"), 404, "not_found");
    expectError(await send(buyer, conversationId(listingId, stranger.uid), "Coucou"), 404, "not_found");
  });

  it("masks links, flags the message for its recipient and keeps the original as evidence", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    const sent = await send(seller, cid, "Payez l'acompte ici https://paiement-securise.example.com/x et appelez 0612345678");
    expect(sent.status).toBe(201);
    expect(sent.body.flags).toEqual(["external_url", "payment_kw", "contact_with_payment_kw"]);
    const stored = await messageDoc(cid, sent.body.messageId);
    expect(stored.text).toBe(`Payez l'acompte ici ${URL_MARKER} et appelez 0612345678`);
    expect(stored.risk).toEqual({ flags: ["external_url", "payment_kw", "contact_with_payment_kw"], warned: true });
    expect(await evidenceDoc(cid, sent.body.messageId)).toMatchObject({ text: "Payez l'acompte ici https://paiement-securise.example.com/x et appelez 0612345678", reason: "masked" });
    expect((await conversationDoc(cid)).lastMessage).toMatchObject({ flagged: true, preview: `Payez l'acompte ici ${URL_MARKER} et appelez 0612345678` });

    const plain = await send(buyer, cid, "Je vous appelle au 0612345678 sur WhatsApp");
    expect(plain.body.flags).toEqual([]);
    expect(await evidenceDoc(cid, plain.body.messageId)).toBeUndefined();
  });

  it("files one system report when a sender's flagged messages repeat across conversations", async () => {
    const seller = await member();
    const [a, b] = await Promise.all([member(), member()]);
    const { id } = await seedListing(seller);
    const first = await startOk(a, id);
    const second = await startOk(b, id);
    await send(seller, first.cid, "Envoyez un acompte par Western Union");
    await send(seller, first.cid, "Le virement d'abord");
    expect(reports).toEqual([]);
    await send(seller, second.cid, "Avance par wafacash svp");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ uid: seller.uid, publicId: (await getConversation(first.cid))!.sellerPublicId });
    expect(reports[0]!.explanation).not.toContain("Western");
    await send(seller, second.cid, "Encore une avance");
    expect(reports).toHaveLength(1);
  });

  it("refuses frozen conversations and accounts over the send limit", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    expect(await freezeConversation(cid, "authority:ar1", true)).toBe(true);
    expectError(await send(seller, cid, "Toujours là ?"), 409, "conversation_unavailable");
    expect(await freezeConversation(cid, "authority:ar1", false)).toBe(true);
    expect((await send(seller, cid, "Toujours là ?")).status).toBe(201);

    await spend("message.send.uid", seller.uid);
    expectError(await send(seller, cid, "Encore"), 429, "rate_limited");
  });

  it("caps sends per hour, per day and per thread besides the burst (audit D1a-01)", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await spend("message.send.hour.uid", seller.uid);
    expectError(await send(seller, cid, "Encore"), 429, "rate_limited");
    resetRateLimiters();
    await spend("message.send.day.uid", seller.uid);
    expectError(await send(seller, cid, "Encore"), 429, "rate_limited");
    resetRateLimiters();
    await spend("message.send.thread", `${seller.uid}:${cid}`);
    expectError(await send(seller, cid, "Encore"), 429, "rate_limited");
    expect(await conversationDoc(cid)).toMatchObject({ messageCount: 1 });
    // The per-thread cap is per (account, thread): another thread of the account, and the buyer in this one, still write.
    const other = await seedListing(seller, { title: "Casque vélo" });
    const second = await startOk(buyer, other.id);
    expect((await send(seller, second.cid, "Ici oui")).status).toBe(201);
    expect((await send(buyer, cid, "Vous êtes là ?")).status).toBe(201);
    // The first message of a conversation counts on the same limiters, before any read.
    resetRateLimiters();
    const third = await seedListing(seller, { title: "Antivol" });
    await spend("message.send.thread", `${buyer.uid}:${conversationId(third.id, buyer.uid)}`);
    expectError(await start(buyer, { listingId: third.id, text: "Salam", turnstileToken: "ok" }), 429, "rate_limited");
    expect(await getConversation(conversationId(third.id, buyer.uid))).toBeNull();
    resetRateLimiters();
    await spend("message.send.day.uid", buyer.uid);
    expectError(await start(buyer, { listingId: third.id, text: "Salam", turnstileToken: "ok" }), 429, "rate_limited");
  });

  it("refuses a suspended sender (403) while he may still read and archive", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await withClaims(seller, { role: "individual", st: "suspended" });
    expectError(await send(seller, cid, "Salam"), 403, "account_suspended");
    expect((await markRead(seller, cid)).status).toBe(204);
    expect((await setState(seller, cid, { archived: true })).status).toBe(204);
    expect((await unread(seller)).status).toBe(200);
  });
});

describe("blocking", () => {
  it("blocks account-wide from a conversation, both ways, until unblocked", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    const other = await seedListing(seller, { title: "Casque vélo" });
    const second = await startOk(buyer, other.id);

    expect((await setState(seller, cid, { blocked: true })).status).toBe(204);
    expect((await db().collection(COLLECTIONS.userBlocks).doc(seller.uid).get()).get("uids")).toEqual([buyer.uid]);
    expect((await conversationDoc(cid)).blockedBy).toEqual([seller.uid]);
    expect((await conversationDoc(second.cid)).blockedBy).toEqual([seller.uid]);
    expectError(await send(buyer, cid, "Pourquoi ?"), 403, "conversation_blocked");
    expectError(await send(buyer, second.cid, "Et ici ?"), 403, "conversation_blocked");
    expectError(await send(seller, cid, "Moi non plus"), 403, "conversation_blocked");
    const third = await seedListing(seller, { title: "Antivol" });
    expectError(await start(buyer, { listingId: third.id, text: "Salam", turnstileToken: "ok" }), 403, "conversation_blocked");

    expect((await setState(seller, cid, { blocked: false })).status).toBe(204);
    expect((await conversationDoc(second.cid)).blockedBy).toEqual([]);
    expect((await send(buyer, second.cid, "Merci")).status).toBe(201);
  });

  it("refuses a send when a block list says so, even with a clean mirror on the conversation (audit D1a-10)", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await db().collection(COLLECTIONS.userBlocks).doc(seller.uid).set({ uids: [buyer.uid], updatedAt: new Date() });
    expect((await conversationDoc(cid)).blockedBy).toEqual([]);
    expectError(await send(buyer, cid, "Pourquoi ?"), 403, "conversation_blocked");
    expectError(await send(seller, cid, "Moi non plus"), 403, "conversation_blocked");
    expectError(await start(buyer, { listingId, text: "Encore ?", turnstileToken: "ok" }), 403, "conversation_blocked");
    expect(await conversationDoc(cid)).toMatchObject({ messageCount: 1, blockedBy: [] });
    await db().collection(COLLECTIONS.userBlocks).doc(seller.uid).delete();
    expect((await send(buyer, cid, "Merci")).status).toBe(201);
  });

  it("mirrors a block on every conversation of the pair, beyond one page of 100 (audit D1a-10)", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    const template = await conversationDoc(cid);
    const batch = db().batch();
    for (let index = 0; index < 120; index += 1) {
      const id = `l${index}${listingId}`;
      batch.set(db().collection(COLLECTIONS.conversations).doc(conversationId(id, buyer.uid)), { ...template, listingId: id });
    }
    await batch.commit();
    const mirrored = () => db().collection(COLLECTIONS.conversations).where("blockedBy", "array-contains", seller.uid).get();

    expect((await setState(seller, cid, { blocked: true })).status).toBe(204);
    expect((await mirrored()).size).toBe(121);
    expect((await setState(seller, cid, { blocked: false })).status).toBe(204);
    expect((await mirrored()).size).toBe(0);
  });
});

describe("POST /api/conversations/{cid}/read and /state", () => {
  it("zeroes my count and stamps readAt on the newest incoming message only", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid, messageId: firstId } = await startOk(buyer, listingId);
    const second = await send(buyer, cid, "Vous êtes là ?");
    await send(seller, cid, "Oui");
    expect((await conversationDoc(cid)).unread).toEqual({ [seller.uid]: 2, [buyer.uid]: 1 });

    expect((await markRead(seller, cid)).status).toBe(204);
    expect((await conversationDoc(cid)).unread).toEqual({ [seller.uid]: 0, [buyer.uid]: 1 });
    expect((await messageDoc(cid, second.body.messageId)).readAt).toBeDefined();
    expect((await messageDoc(cid, firstId)).readAt).toBeUndefined();
    // Nothing unread: no write.
    expect((await markRead(seller, cid)).status).toBe(204);
    expectError(await markRead(await member(), cid), 404, "not_found");
  });

  it("archives and unarchives for me only, deletes for me (count zeroed), validates the body", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await setState(seller, cid, { archived: true });
    expect((await conversationDoc(cid)).archivedBy).toEqual([seller.uid]);
    await setState(seller, cid, { archived: false });
    expect((await conversationDoc(cid)).archivedBy).toEqual([]);
    await setState(seller, cid, { hidden: true });
    expect(await conversationDoc(cid)).toMatchObject({ hiddenFor: [seller.uid], unread: { [seller.uid]: 0 } });
    expectError(await setState(seller, cid, { archived: true, hidden: true }), 400, "invalid_body");
    expectError(await setState(seller, cid, { hidden: false }), 400, "invalid_body");
    expectError(await setState(await member(), cid, { archived: true }), 404, "not_found");
  });
});

describe("GET /api/messages/unread", () => {
  it("rebuilds the badge from Firestore once, follows new messages and reads, marks the account active", async () => {
    const { buyer, seller, listingId } = await pair();
    const { cid } = await startOk(buyer, listingId);
    await send(buyer, cid, "Bonjour ?");
    const first = await unread(seller);
    expect(first.body).toEqual({ total: 2 });
    expect(valkey.ttlMs(MESSAGING_KEYS.seen(seller.uid))).toBeGreaterThan(0);
    await send(buyer, cid, "Allô ?");
    expect((await unread(seller)).body).toEqual({ total: 3 });
    await markRead(seller, cid);
    expect((await unread(seller)).body).toEqual({ total: 0 });
    expectError(await unread(undefined), 401, "unauthenticated");
  });

  it("answers 503 while Valkey fails, and reads Firestore when Valkey is not configured (dev)", async () => {
    const { buyer, seller, listingId } = await pair();
    await startOk(buyer, listingId);
    valkey.failing = true;
    expectError(await unread(seller), 503, "unavailable");
    setMessagingValkeyForTests(null);
    expect((await unread(seller)).body).toEqual({ total: 1 });
  });
});
