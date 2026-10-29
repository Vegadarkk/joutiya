import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({ ...(await importOriginal<typeof Turnstile>()), verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { POST as offerRoute } from "@/app/api/conversations/[cid]/offer/route";
import { OFFER_TTL_MS, offerPath, type OfferResponse } from "@/lib/contracts/offers";
import { staffOfferText } from "@/lib/decisions/staff-conversations";
import { setEventPublisherForTests, type Delivery } from "@/lib/messaging/events";
import { getConversation } from "@/lib/messaging/repository";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { listDueOffers } from "@/lib/offers/expiry";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { expireOffers } from "@/worker/jobs/offer-expiry";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { call, type CallResult } from "../favorites/helpers";
import { expectError, member, row, seedListing, start, startOk, thread, type ErrorBody, type Member } from "./helpers";

// Price offers on the emulators (Carte vivante lot 5): the first message carries the offer, the
// seller counters with a note, the buyer accepts; bounds, ineligible listings, one pending offer,
// the per-conversation limit, the 48 h expiry job, and the live events of each step.

let deliveries: Delivery[] = [];

beforeEach(() => {
  resetRateLimiters();
  deliveries = [];
  setMessagingValkeyForTests(new FakeValkey().asClient());
  setEventPublisherForTests(async (batch) => {
    deliveries.push(...batch);
  });
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setEventPublisherForTests(undefined);
});

function act(who: Member, cid: string, body: unknown): Promise<CallResult<OfferResponse & ErrorBody>> {
  return call(offerRoute, "POST", offerPath(cid), { member: who, params: { cid }, body });
}

async function actOk(who: Member, cid: string, body: unknown): Promise<OfferResponse> {
  const result = await act(who, cid, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

async function bikeListing(overrides: Parameters<typeof seedListing>[1] = {}) {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const listing = await seedListing(seller, { price: 1000, ...overrides });
  return { buyer, seller, listing };
}

async function offerOk(buyer: Member, listingId: string, amount: number) {
  const result = await start(buyer, { listingId, text: "Bonjour, je vous propose ce prix.", turnstileToken: "ok", offer: { amount } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

describe("price offer", () => {
  it("makes the offer with the first message, then the seller counters with a note and the buyer accepts", async () => {
    const { buyer, seller, listing } = await bikeListing();
    const { cid } = await offerOk(buyer, listing.id, 800);

    const seen = await thread(seller, cid);
    expect(seen.status).toBe(200);
    expect(seen.body.conversation.offer).toMatchObject({ status: "open", madeByMe: false, amount: 800, counter: null, price: 1000 });
    expect(seen.body.conversation.offersAllowed).toBe(true);
    expect(seen.body.messages.map((message) => message.type)).toEqual(["system", "text"]);
    expect(seen.body.messages[0]).toMatchObject({ text: "⟦offre:made⟧", offer: { event: "made", byMe: false, amount: 800 } });
    expect(seen.body.conversation.unread).toBe(2);
    const offer = seen.body.conversation.offer!;
    expect(offer.expiresAt - Date.now()).toBeGreaterThan(OFFER_TTL_MS - 60_000);

    // Only the seller answers an open offer; a counter-offer stays within the bounds, above the offer.
    expectError(await act(buyer, cid, { action: "accept", id: offer.id }), 409, "offer_changed");
    expectError(await act(seller, cid, { action: "counter", id: offer.id, amount: 750 }), 400, "invalid_body");
    expectError(await act(seller, cid, { action: "counter", id: offer.id, amount: 1200 }), 400, "invalid_body");
    deliveries = [];
    const countered = await actOk(seller, cid, { action: "counter", id: offer.id, amount: 900, note: "Je peux descendre à 900, voir www.exemple.com" });
    expect(countered.offer).toMatchObject({ status: "countered", madeByMe: false, amount: 800, counter: 900 });
    expect(deliveries.some((delivery) => delivery.uid === buyer.uid)).toBe(true);

    const buyerThread = await thread(buyer, cid);
    expect(buyerThread.body.messages.slice(0, 2).map((message) => [message.type, message.text])).toEqual([
      ["text", "Je peux descendre à 900, voir ⟦url⟧"],
      ["system", "⟦offre:countered⟧"],
    ]);
    expect(buyerThread.body.conversation.offer).toMatchObject({ status: "countered", madeByMe: true, counter: 900 });

    expectError(await act(seller, cid, { action: "accept", id: offer.id }), 409, "offer_changed");
    const accepted = await actOk(buyer, cid, { action: "accept", id: offer.id });
    expect(accepted.offer).toMatchObject({ status: "accepted", madeByMe: true, counter: 900 });
    const sellerView = await row(seller, cid);
    expect(sellerView.body.conversation.offer).toMatchObject({ status: "accepted", madeByMe: false });
    const events = (await thread(seller, cid)).body.messages.flatMap((message) => (message.offer ? [[message.offer.event, message.offer.amount]] : []));
    expect(events).toEqual([
      ["accepted", 900],
      ["countered", 900],
      ["made", 800],
    ]);
    // Answered: no deadline left for the expiry job.
    expect((await getConversation(cid))?.offerExpiresAt ?? null).toBeNull();
    expect(staffOfferText({ id: offer.id, event: "accepted", amount: 900 })).toContain("900 DH");
  });

  it("lets the seller decline and the buyer make a new offer from the thread, one pending at a time", async () => {
    const { buyer, seller, listing } = await bikeListing();
    const { cid } = await offerOk(buyer, listing.id, 700);
    const first = (await row(seller, cid)).body.conversation.offer!;
    expectError(await act(buyer, cid, { action: "make", amount: 750 }), 409, "offer_pending");
    expectError(await act(seller, cid, { action: "make", amount: 750 }), 403, "forbidden");
    expect((await actOk(seller, cid, { action: "decline", id: first.id })).offer.status).toBe("declined");

    const second = await actOk(buyer, cid, { action: "make", amount: 850, note: "Dernière proposition" });
    expect(second.offer).toMatchObject({ status: "open", madeByMe: true, amount: 850 });
    expect(second.offer.id).not.toBe(first.id);
    expect((await actOk(buyer, cid, { action: "withdraw", id: second.offer.id })).offer.status).toBe("withdrawn");
    expectError(await act(seller, cid, { action: "accept", id: second.offer.id }), 409, "offer_changed");
  });

  it("refuses amounts out of bounds and listings without offers, before writing anything", async () => {
    const { buyer, seller, listing } = await bikeListing();
    expectError(await start(buyer, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", offer: { amount: 299 } }), 400, "invalid_body");
    expectError(await start(buyer, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", offer: { amount: 1001 } }), 400, "invalid_body");

    const donation = await seedListing(seller, { price: null, isDonation: true });
    expectError(await start(buyer, { listingId: donation.id, text: "Bonjour", turnstileToken: "ok", offer: { amount: 100 } }), 409, "offer_unavailable");
    const lesson = await seedListing(seller, { categoryId: "services", subcategoryId: "cours", title: "Cours de maths", price: 150 });
    expectError(await start(buyer, { listingId: lesson.id, text: "Bonjour", turnstileToken: "ok", offer: { amount: 100 } }), 409, "offer_unavailable");
    const flat = await seedListing(seller, { categoryId: "immobilier", subcategoryId: "location", title: "Appartement à louer", price: 5000 });
    expectError(await start(buyer, { listingId: flat.id, text: "Bonjour", turnstileToken: "ok", offer: { amount: 4500 } }), 409, "offer_unavailable");

    // A plain conversation about a donation: no offer from the thread either.
    const { cid } = await startOk(buyer, donation.id);
    expect((await row(buyer, cid)).body.conversation.offersAllowed).toBe(false);
    expectError(await act(buyer, cid, { action: "make", amount: 100 }), 409, "offer_unavailable");
  });

  it("caps offers at 5 a day per conversation", async () => {
    const { buyer, listing } = await bikeListing();
    const { cid } = await offerOk(buyer, listing.id, 800);
    let id = (await row(buyer, cid)).body.conversation.offer!.id;
    for (let index = 1; index < 5; index += 1) {
      await actOk(buyer, cid, { action: "withdraw", id });
      id = (await actOk(buyer, cid, { action: "make", amount: 800 + index })).offer.id;
    }
    await actOk(buyer, cid, { action: "withdraw", id });
    expectError(await act(buyer, cid, { action: "make", amount: 900 }), 429, "rate_limited");
  });
});

describe("job offer-expiry", () => {
  it("expires an unanswered offer after 48 h with its thread step, then leaves it alone", async () => {
    const { buyer, seller, listing } = await bikeListing();
    const { cid } = await offerOk(buyer, listing.id, 800);
    expect(await listDueOffers(new Date())).not.toContain(cid);
    const later = new Date(Date.now() + OFFER_TTL_MS + 60_000);
    expect(await listDueOffers(later)).toContain(cid);

    // Past the 48 h the readers see it expired at once, and answers are refused.
    const offer = (await row(seller, cid)).body.conversation.offer!;
    deliveries = [];
    const result = await expireOffers(later);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(deliveries.map((delivery) => delivery.uid).sort()).toEqual(expect.arrayContaining([buyer.uid, seller.uid].sort()));
    const page = await thread(buyer, cid);
    expect(page.body.messages[0]).toMatchObject({ type: "system", text: "⟦offre:expired⟧", offer: { event: "expired", amount: 800 } });
    expect(page.body.conversation.offer?.status).toBe("expired");
    expect(await listDueOffers(later)).not.toContain(cid);
    expectError(await act(seller, cid, { action: "accept", id: offer.id }), 409, "offer_changed");
    // A new offer is possible again.
    expect((await actOk(buyer, cid, { action: "make", amount: 850 })).offer.status).toBe("open");
  });
});
