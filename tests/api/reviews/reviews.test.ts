import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { Timestamp } from "firebase-admin/firestore";
import { GET as mineRoute } from "@/app/api/account/reviews/route";
import { DELETE as deleteRoute } from "@/app/api/reviews/[id]/route";
import { POST as replyRoute } from "@/app/api/reviews/[id]/reply/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/reviews/route";
import { REVIEWS_API, type MyReviews, type ReviewCreated, type ReviewPage, type ReviewView } from "@/lib/contracts/reviews";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { firstDegraded } from "@/lib/quota";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { anonymizeAuthoredReviews, reviewId, setReviewStatus } from "@/lib/reviews/repository";
import { getPublicProfile } from "@/lib/listings/public";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { call, type CallResult } from "../favorites/helpers";
import { expectError, member, seedListing, send, startOk, type ErrorBody, type Member } from "../messaging/helpers";

// Verified reviews on the emulators (vitrine-avis §2-3): only the buyer of a conversation, after
// the seller's reply and a 24 h delay, once; the screen of the text; the seller's one reply; the
// public list without uids; "Mes avis"; the author's delete; the seller's aggregates kept exact
// through publication, deletion and moderation; the author's name gone at account closure.

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT = "Échange rapide et courtois, l'article était conforme à l'annonce.";

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  vi.mocked(firstDegraded).mockResolvedValue(null);
});

afterAll(() => setMessagingValkeyForTests(undefined));

type Body<T> = T & Partial<ErrorBody>;

function create(who: Member | undefined, body: unknown): Promise<CallResult<Body<ReviewCreated>>> {
  return call(createRoute, "POST", REVIEWS_API.create, { member: who, body });
}

function list(publicId: string, after?: string): Promise<CallResult<Body<ReviewPage>>> {
  const query = new URLSearchParams({ vendeur: publicId, ...(after ? { apres: after } : {}) });
  return call(listRoute, "GET", `${REVIEWS_API.list}?${query.toString()}`);
}

function reply(who: Member, id: string, text: string): Promise<CallResult<Body<ReviewView>>> {
  return call(replyRoute, "POST", REVIEWS_API.reply(id), { member: who, body: { text }, params: { id } });
}

function remove(who: Member, id: string): Promise<CallResult<ErrorBody | null>> {
  return call(deleteRoute, "DELETE", REVIEWS_API.item(id), { member: who, params: { id } });
}

function mine(who: Member, side: "recus" | "donnes"): Promise<CallResult<Body<MyReviews>>> {
  return call(mineRoute, "GET", `${REVIEWS_API.mine}?sens=${side}`, { member: who });
}

/** A conversation where the seller answered: its first reply moved `ago` ms back (the window opens 24 h after it). */
async function exchange(options: { ago?: number; reply?: boolean } = {}): Promise<{ buyer: Member; seller: Member; cid: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id } = await seedListing(seller);
  const { cid } = await startOk(buyer, id);
  if (options.reply !== false) {
    const sent = await send(seller, cid, "Oui, toujours disponible. Rendez-vous demain ?");
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    if (options.ago) await db().collection(COLLECTIONS.conversations).doc(cid).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - options.ago) });
  }
  return { buyer, seller, cid };
}

async function stats(uid: string) {
  const user = await getUserRecord(uid);
  return { count: user!.stats.ratingCount, sum: user!.stats.ratingSum, avg: user!.stats.ratingAvg, histogram: user!.stats.ratingHistogram };
}

describe("POST /api/reviews", () => {
  it("opens to the buyer 24 h after the seller's first reply, once per conversation", async () => {
    const silent = await exchange({ reply: false });
    const noReply = await create(silent.buyer, { cid: silent.cid, rating: 5, text: TEXT, exchangeConfirmed: true });
    expectError(noReply, 409, "review_unavailable");
    expect(noReply.body.error?.details).toEqual({ state: "no_reply" });

    const early = await exchange();
    const tooEarly = await create(early.buyer, { cid: early.cid, rating: 5, text: TEXT, exchangeConfirmed: true });
    expectError(tooEarly, 409, "review_unavailable");
    expect(tooEarly.body.error?.details).toMatchObject({ state: "too_early", opensAt: expect.any(Number) });

    const { buyer, seller, cid } = await exchange({ ago: 2 * DAY_MS });
    const created = await create(buyer, { cid, rating: 4, text: TEXT, exchangeConfirmed: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toEqual({ id: reviewId(buyer.uid, seller.uid), status: "published", replaced: false });
    expect(await stats(seller.uid)).toEqual({ count: 1, sum: 4, avg: 4, histogram: [0, 0, 0, 1, 0] });
    const conversation = (await db().collection(COLLECTIONS.conversations).doc(cid).get()).data()!;
    expect(conversation.reviewedAt).toBeInstanceOf(Timestamp);

    const again = await create(buyer, { cid, rating: 1, text: TEXT, exchangeConfirmed: true });
    expectError(again, 409, "review_unavailable");
    expect(again.body.error?.details).toEqual({ state: "done" });
    expect(await stats(seller.uid)).toMatchObject({ count: 1, sum: 4 });
  });

  it("is the buyer's only: the seller and strangers get a 404", async () => {
    const { seller, cid } = await exchange({ ago: 2 * DAY_MS });
    const stranger = await member();
    expectError(await create(seller, { cid, rating: 5, text: TEXT, exchangeConfirmed: true }), 404, "not_found");
    expectError(await create(stranger, { cid, rating: 5, text: TEXT, exchangeConfirmed: true }), 404, "not_found");
    expectError(await create(undefined, { cid, rating: 5, text: TEXT, exchangeConfirmed: true }), 401, "unauthenticated");
  });

  it("closes 60 days after the last message", async () => {
    const { buyer, cid } = await exchange({ ago: 70 * DAY_MS });
    await db().collection(COLLECTIONS.conversations).doc(cid).update({ "lastMessage.at": Timestamp.fromMillis(Date.now() - 61 * DAY_MS) });
    const closed = await create(buyer, { cid, rating: 3, text: TEXT, exchangeConfirmed: true });
    expectError(closed, 409, "review_unavailable");
    expect(closed.body.error?.details).toEqual({ state: "closed" });
  });

  it("checks the body: the statement, the length, contact details refused, sensitive data held", async () => {
    const { buyer, seller, cid } = await exchange({ ago: 2 * DAY_MS });
    expectError(await create(buyer, { cid, rating: 5, text: TEXT }), 400, "invalid_body");
    expectError(await create(buyer, { cid, rating: 5, text: "Très bien", exchangeConfirmed: true }), 400, "invalid_body");
    expectError(await create(buyer, { cid, rating: 6, text: TEXT, exchangeConfirmed: true }), 400, "invalid_body");
    const phone = await create(buyer, { cid, rating: 5, text: `${TEXT} Appelez le 06 12 34 56 78`, exchangeConfirmed: true });
    expectError(phone, 422, "invalid_text");
    expect(phone.body.error?.details).toEqual({ field: "text", issue: "phone_in_text" });

    const held = await create(buyer, { cid, rating: 2, text: "Rencontre agréable, ma femme est diabétique et le vendeur a porté le colis jusqu'à la voiture.", exchangeConfirmed: true });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body.status).toBe("pending");
    expect((await stats(seller.uid)).count).toBe(0);
    const sellerRecord = await getUserRecord(seller.uid);
    expect((await list(sellerRecord!.publicId)).body.reviews).toEqual([]);

    // A moderator publishes it: it enters the average; hidden again, it leaves it.
    await setReviewStatus(held.body.id, "published", new Date());
    expect(await stats(seller.uid)).toEqual({ count: 1, sum: 2, avg: 2, histogram: [0, 1, 0, 0, 0] });
    await setReviewStatus(held.body.id, "hidden", new Date(), "decision-1");
    expect(await stats(seller.uid)).toMatchObject({ count: 0, sum: 0, avg: 0 });
    const doc = (await db().collection(COLLECTIONS.reviews).doc(held.body.id).get()).data()!;
    expect(doc).toMatchObject({ status: "hidden", hiddenBy: "decision-1" });
    expect(doc.purgeAt).toBeInstanceOf(Timestamp);
  });
});

describe("storefront reviews, reply, Mes avis, delete", () => {
  it("lists published reviews without uids, takes one reply from the seller, and the author deletes", async () => {
    const { buyer, seller, cid } = await exchange({ ago: 2 * DAY_MS });
    const created = await create(buyer, { cid, rating: 5, text: TEXT, exchangeConfirmed: true });
    const id = created.body.id;
    const sellerRecord = await getUserRecord(seller.uid);
    const publicId = sellerRecord!.publicId;

    const page = await list(publicId);
    expect(page.status).toBe(200);
    expect(page.body.reviews).toHaveLength(1);
    expect(page.body.reviews[0]).toEqual({
      id,
      rating: 5,
      text: TEXT,
      authorName: "Youssef Acheteur",
      listingTitle: expect.any(String),
      createdAt: expect.any(Number),
      experienceAt: expect.any(Number),
      reply: null,
    });
    expect(JSON.stringify(page.body)).not.toContain(buyer.uid);
    expect(JSON.stringify(page.body)).not.toContain(cid);
    expectError(await list("zzzzzzzzzz"), 404, "not_found");

    const profile = await getPublicProfile(publicId);
    expect(profile?.rating).toEqual({ count: 1, average: 5, histogram: [0, 0, 0, 0, 1] });
    expect(profile?.reviews.reviews.map((review) => review.id)).toEqual([id]);

    expectError(await reply(buyer, id, "Merci !"), 404, "not_found");
    const answered = await reply(seller, id, "Merci pour votre achat, bonne continuation.");
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.reply).toEqual({ text: "Merci pour votre achat, bonne continuation.", at: expect.any(Number) });
    expectError(await reply(seller, id, "Encore merci"), 409, "review_unavailable");
    expectError(await reply(seller, reviewId("x".repeat(22), "y".repeat(22)), "Merci"), 404, "not_found");

    const received = await mine(seller, "recus");
    expect(received.body.reviews).toEqual([expect.objectContaining({ id, status: "published", counterpartName: "Youssef Acheteur", canReply: false, canDelete: false })]);
    const given = await mine(buyer, "donnes");
    expect(given.body.reviews).toEqual([expect.objectContaining({ id, status: "published", counterpartName: "Salma Vendeuse", canReply: false, canDelete: true })]);

    expectError(await remove(seller, id), 404, "not_found");
    expect((await remove(buyer, id)).status).toBe(204);
    expect(await stats(seller.uid)).toMatchObject({ count: 0, sum: 0 });
    expect((await list(publicId)).body.reviews).toEqual([]);
    expect((await mine(buyer, "donnes")).body.reviews).toEqual([]);
    const doc = (await db().collection(COLLECTIONS.reviews).doc(id).get()).data()!;
    expect(doc.status).toBe("deleted");
    expect(doc.purgeAt).toBeInstanceOf(Timestamp);
    // Deleted: no second review for the same conversation.
    expectError(await create(buyer, { cid, rating: 1, text: TEXT, exchangeConfirmed: true }), 409, "review_unavailable");
  });

  it("pages the storefront list with a cursor", async () => {
    const seller = await member({ displayName: "Salma Vendeuse" });
    const { id: listingId } = await seedListing(seller);
    for (let index = 0; index < 11; index += 1) {
      const buyer = await member({ displayName: `Acheteur ${index}` });
      const { cid } = await startOk(buyer, listingId);
      await send(seller, cid, "Bonjour, oui.");
      await db().collection(COLLECTIONS.conversations).doc(cid).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
      const created = await create(buyer, { cid, rating: (index % 5) + 1, text: TEXT, exchangeConfirmed: true });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    }
    const publicId = (await getUserRecord(seller.uid))!.publicId;
    const first = await list(publicId);
    expect(first.body.reviews).toHaveLength(10);
    expect(first.body.next).toEqual(expect.any(String));
    const second = await list(publicId, first.body.next!);
    expect(second.body.reviews).toHaveLength(1);
    expect(second.body.next).toBeNull();
    expect(new Set([...first.body.reviews, ...second.body.reviews].map((review) => review.id)).size).toBe(11);
    expectError(await list(publicId, "not a cursor!"), 400, "invalid_body");
    expect(await stats(seller.uid)).toEqual({ count: 11, sum: 31, avg: 2.82, histogram: [3, 2, 2, 2, 2] });
  });

  it("keeps one review per buyer and seller: a later exchange replaces it, never a hidden one", async () => {
    const { buyer, seller, cid } = await exchange({ ago: 2 * DAY_MS });
    const first = await create(buyer, { cid, rating: 2, text: TEXT, exchangeConfirmed: true });
    expect(first.body).toEqual({ id: reviewId(buyer.uid, seller.uid), status: "published", replaced: false });
    const id = first.body.id;
    expect((await reply(seller, id, "Désolée pour le retard de la dernière fois.")).status).toBe(200);

    // A second listing of the same seller: the new review takes the same place.
    const { id: listingId } = await seedListing(seller);
    const { cid: second } = await startOk(buyer, listingId);
    await send(seller, second, "Bonjour, oui, toujours disponible.");
    await db().collection(COLLECTIONS.conversations).doc(second).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
    const replaced = await create(buyer, { cid: second, rating: 5, text: TEXT, exchangeConfirmed: true });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body).toEqual({ id, status: "published", replaced: true });
    expect(await stats(seller.uid)).toEqual({ count: 1, sum: 5, avg: 5, histogram: [0, 0, 0, 0, 1] });
    const doc = (await db().collection(COLLECTIONS.reviews).doc(id).get()).data()!;
    expect(doc).toMatchObject({ conversationId: second, listingId, rating: 5 });
    expect(doc.reply).toBeUndefined();
    const publicId = (await getUserRecord(seller.uid))!.publicId;
    expect((await list(publicId)).body.reviews).toHaveLength(1);

    // A review a moderator hid stays as it is: no new review of that seller replaces it.
    await setReviewStatus(id, "hidden", new Date(), "decision:test");
    const { id: thirdListing } = await seedListing(seller);
    const { cid: third } = await startOk(buyer, thirdListing);
    await send(seller, third, "Bonjour.");
    await db().collection(COLLECTIONS.conversations).doc(third).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - 2 * DAY_MS) });
    expectError(await create(buyer, { cid: third, rating: 5, text: TEXT, exchangeConfirmed: true }), 409, "review_unavailable");
    expect(await stats(seller.uid)).toMatchObject({ count: 0, sum: 0 });
  });

  it("opens no review on a one-click decline of the seller, only on a real answer", async () => {
    const { verifiesExchange } = await import("@/lib/messaging/repository");
    const seller = "seller-uid";
    expect(verifiesExchange({ senderUid: seller }, seller)).toBe(true);
    expect(verifiesExchange({ senderUid: "buyer-uid" }, seller)).toBe(false);
    expect(verifiesExchange({ senderUid: seller, offer: { id: "o", event: "declined", amount: 100 } as never }, seller)).toBe(false);
    expect(verifiesExchange({ senderUid: "buyer-uid", offer: { id: "o", event: "accepted", amount: 100 } as never }, seller)).toBe(true);
    expect(verifiesExchange({ senderUid: seller, appointment: { event: "proposed" } as never }, seller)).toBe(false);
    expect(verifiesExchange({ senderUid: "buyer-uid", appointment: { event: "confirmed" } as never }, seller)).toBe(true);
    expect(verifiesExchange({ senderUid: seller, rentalRequest: { event: "declined" } as never }, seller)).toBe(false);
    expect(verifiesExchange({ senderUid: seller, rentalRequest: { event: "accepted" } as never }, seller)).toBe(true);
  });

  it("drops the author's name when the author's account closes", async () => {
    const { buyer, seller, cid } = await exchange({ ago: 2 * DAY_MS });
    await create(buyer, { cid, rating: 5, text: TEXT, exchangeConfirmed: true });
    const sellerPublicId = (await getUserRecord(seller.uid))!.publicId;
    expect(await anonymizeAuthoredReviews(buyer.uid, new Date())).toEqual([sellerPublicId]);
    expect((await list(sellerPublicId)).body.reviews[0]?.authorName).toBe("");
    expect(await anonymizeAuthoredReviews(buyer.uid, new Date())).toEqual([]);
  });
});
