import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({ ...(await importOriginal<typeof Turnstile>()), verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { POST as rentalRequestRoute } from "@/app/api/conversations/[cid]/rental-request/route";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type { RentalRequestResponse } from "@/lib/contracts/rental-requests";
import { getListing } from "@/lib/db/repositories/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { conversationId } from "@/lib/messaging/ids";
import { setEventPublisherForTests } from "@/lib/messaging/events";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { resolveReportTarget } from "@/lib/reports/targets";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { call, type CallResult } from "../favorites/helpers";
import { expectError, member, row, seedListing, start, startOk, thread, type ErrorBody, type Member } from "./helpers";

// Booking requests of a car rental on the emulators (rental pack §6): the first message carries
// the request, the agency accepts (writing the days on the listing) or declines, the renter
// withdraws or replaces it; every step is a system message; non-rental listings and the wrong
// participant are refused. A holiday home's stay (seasonal rental conception §3) takes the same
// steps by nights, from an individual host too.

const day = (offset: number) => dayString(moroccoToday(new Date()) + offset);

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  setEventPublisherForTests(async () => {});
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setEventPublisherForTests(undefined);
});

function act(who: Member, cid: string, body: unknown): Promise<CallResult<RentalRequestResponse & ErrorBody>> {
  return call(rentalRequestRoute, "POST", MESSAGING_API.rentalRequest(cid), { member: who, params: { cid }, body });
}

async function actOk(who: Member, cid: string, body: unknown): Promise<RentalRequestResponse> {
  const result = await act(who, cid, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

async function rentalListing(overrides: Parameters<typeof seedListing>[1] = {}) {
  const [renter, agency] = await Promise.all([member({ displayName: "Youssef Locataire" }), member({ displayName: "Atlas Cars" })]);
  const listing = await seedListing(agency, { categoryId: "vehicules", subcategoryId: "location-voitures", title: "Dacia Logan 2024", price: 300, priceNegotiable: false, ...overrides });
  return { renter, agency, listing };
}

async function requestOk(renter: Member, listingId: string, rentalRequest: unknown) {
  const result = await start(renter, { listingId, text: "Bonjour, est-ce disponible ?", turnstileToken: "ok", rentalRequest });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

describe("booking request of a car rental", () => {
  it("sends the request with the first message, then the agency accepts and blocks the days", async () => {
    const { renter, agency, listing } = await rentalListing({ rental: { unavailable: [{ from: day(20), to: day(22) }], updatedAt: new Date() } });
    const { cid } = await requestOk(renter, listing.id, { from: day(3), to: day(6), pickup: "Aéroport, www.exemple.com" });

    const seen = await thread(agency, cid);
    expect(seen.status).toBe(200);
    expect(seen.body.conversation.rentalRequest).toMatchObject({ status: "requested", requestedByMe: false, from: day(3), to: day(6), pickup: "Aéroport, ⟦url⟧" });
    expect(seen.body.messages.map((message) => message.type)).toEqual(["system", "text"]);
    expect(seen.body.messages[0]).toMatchObject({ text: "⟦location:requested⟧", rentalRequest: { event: "requested", byMe: false, from: day(3) } });
    expect(seen.body.conversation.unread).toBe(2);

    const id = seen.body.conversation.rentalRequest!.id;
    expectError(await act(renter, cid, { action: "accept", id, block: true }), 409, "rental_request_changed");
    const accepted = await actOk(agency, cid, { action: "accept", id, block: true });
    expect(accepted).toMatchObject({ blocked: true, rentalRequest: { status: "accepted", blocked: true, requestedByMe: false } });
    const stored = await getListing(listing.id);
    expect(stored?.rental?.unavailable).toEqual([
      { from: day(3), to: day(6) },
      { from: day(20), to: day(22) },
    ]);

    const renterView = await row(renter, cid);
    expect(renterView.body.conversation.rentalRequest).toMatchObject({ status: "accepted", requestedByMe: true });
    // Answered: nothing more to accept, decline or withdraw.
    expectError(await act(agency, cid, { action: "decline", id }), 409, "rental_request_changed");
    expectError(await act(renter, cid, { action: "withdraw", id }), 409, "rental_request_changed");
  });

  it("accepts without touching the listing when the agency keeps the days open, and lets it decline", async () => {
    const { renter, agency, listing } = await rentalListing();
    const { cid } = await requestOk(renter, listing.id, { from: day(1), to: day(2) });
    const first = (await row(agency, cid)).body.conversation.rentalRequest!;
    const accepted = await actOk(agency, cid, { action: "accept", id: first.id, block: false });
    expect(accepted.blocked).toBeNull();
    expect((await getListing(listing.id))?.rental).toBeUndefined();

    // A new request from the listing page goes to the same conversation and replaces the answered one.
    await requestOk(renter, listing.id, { from: day(10), to: day(12) });
    const second = (await row(agency, cid)).body.conversation.rentalRequest!;
    expect(second).toMatchObject({ status: "requested", from: day(10) });
    expect(second.id).not.toBe(first.id);
    const declined = await actOk(agency, cid, { action: "decline", id: second.id });
    expect(declined.rentalRequest.status).toBe("declined");
    const events = (await thread(renter, cid)).body.messages.flatMap((message) => (message.rentalRequest ? [message.rentalRequest.event] : []));
    expect(events).toEqual(["declined", "requested", "accepted", "requested"]);
  });

  it("lets the renter withdraw or change an unanswered request from the thread", async () => {
    const { renter, agency, listing } = await rentalListing();
    const { cid } = await requestOk(renter, listing.id, { from: day(1), to: day(3) });
    const changed = await actOk(renter, cid, { action: "request", from: day(2), to: day(4) });
    expect(changed.rentalRequest).toMatchObject({ status: "requested", requestedByMe: true, from: day(2) });
    expectError(await act(agency, cid, { action: "request", from: day(2), to: day(4) }), 403, "forbidden");
    const withdrawn = await actOk(renter, cid, { action: "withdraw", id: changed.rentalRequest.id });
    expect(withdrawn.rentalRequest.status).toBe("withdrawn");
    expectError(await act(agency, cid, { action: "accept", id: changed.rentalRequest.id, block: true }), 409, "rental_request_changed");
    expect((await getListing(listing.id))?.rental).toBeUndefined();
  });

  it("refuses dates out of bounds and listings that are no car rental, before writing anything", async () => {
    const { renter, listing } = await rentalListing();
    expectError(await start(renter, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(-1), to: day(2) } }), 400, "invalid_body");
    expectError(await start(renter, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(1), to: day(70) } }), 400, "invalid_body");

    const seller = await member({ displayName: "Salma Vendeuse" });
    const bike = await seedListing(seller);
    expectError(await start(renter, { listingId: bike.id, text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(1), to: day(2) } }), 409, "rental_request_unavailable");
    expect((await thread(renter, (await startOk(renter, bike.id)).cid)).body.messages).toHaveLength(1);

    const { cid } = await startOk(renter, bike.id, "Encore une question");
    expectError(await act(renter, cid, { action: "request", from: day(1), to: day(2) }), 409, "rental_request_unavailable");
  });

  it("refuses a pick-up place with payment details, before the first message is sent (audit A-02)", async () => {
    const { renter, agency, listing } = await rentalListing();
    expectError(await start(renter, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(1), to: day(3), pickup: "Aéroport, acompte par Wafacash" } }), 422, "place_payment_details");
    expect((await db().collection(COLLECTIONS.conversations).doc(conversationId(listing.id, renter.uid)).get()).exists).toBe(false);

    const { cid } = await requestOk(renter, listing.id, { from: day(1), to: day(3), pickup: "Aéroport Mohammed V" });
    expectError(await act(renter, cid, { action: "request", from: day(2), to: day(4), pickup: "RIB 011 780 0000123456789012 34" }), 422, "place_payment_details");
    // The renter's request can be reported by the agency; its answer carries no place.
    const page = await thread(agency, cid);
    const request = page.body.messages.find((message) => message.rentalRequest?.event === "requested");
    expect(request?.rentalRequest?.pickup).toBe("Aéroport Mohammed V");
    expect((await resolveReportTarget({ type: "message", id: `${cid}/${request!.id}` }, agency.uid)).target.ownerUid).toBe(renter.uid);
    const accepted = await actOk(agency, cid, { action: "accept", id: page.body.conversation.rentalRequest!.id, block: false });
    expect((await thread(renter, cid)).body.messages.find((message) => message.id === accepted.messageId)?.rentalRequest?.pickup).toBeNull();
  });

  it("limits new requests to 20 a day per renter", async () => {
    const { renter, listing } = await rentalListing();
    const { cid } = await requestOk(renter, listing.id, { from: day(1), to: day(2) });
    for (let index = 1; index < 20; index += 1) await actOk(renter, cid, { action: "request", from: day(1), to: day(2 + (index % 5)) });
    expectError(await act(renter, cid, { action: "request", from: day(1), to: day(3) }), 429, "rate_limited");
  });
});

describe("stay request of a holiday home", () => {
  async function holidayHome() {
    const [guest, host] = await Promise.all([member({ displayName: "Imane Voyageuse" }), member({ displayName: "Hassan Hôte" })]);
    const listing = await seedListing(host, { categoryId: "immobilier", subcategoryId: "location-vacances", title: "Riad avec patio à Essaouira", price: 800, priceNegotiable: false });
    return { guest, host, listing };
  }

  it("takes the nights with the first message; the host accepts and blocks the nights, the departure day stays free", async () => {
    const { guest, host, listing } = await holidayHome();
    expectError(await start(guest, { listingId: listing.id, text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(3), to: day(3) } }), 400, "invalid_body");
    const { cid } = await requestOk(guest, listing.id, { from: day(3), to: day(6), pickup: "2 adultes, arrivée vers 18 h" });

    const seen = await thread(host, cid);
    expect(seen.body.conversation.rentalRequest).toMatchObject({ status: "requested", unit: "night", from: day(3), to: day(6), pickup: "2 adultes, arrivée vers 18 h" });
    expect(seen.body.messages[0]).toMatchObject({ rentalRequest: { event: "requested", unit: "night" } });

    const accepted = await actOk(host, cid, { action: "accept", id: seen.body.conversation.rentalRequest!.id, block: true });
    expect(accepted).toMatchObject({ blocked: true, rentalRequest: { status: "accepted", unit: "night" } });
    expect((await getListing(listing.id))?.rental?.unavailable).toEqual([{ from: day(3), to: day(5) }]);
  });

  it("refuses a stay without a night from the thread", async () => {
    const { guest, listing } = await holidayHome();
    const { cid } = await requestOk(guest, listing.id, { from: day(1), to: day(2) });
    expectError(await act(guest, cid, { action: "request", from: day(4), to: day(4) }), 400, "invalid_body");
    expect((await actOk(guest, cid, { action: "request", from: day(4), to: day(5) })).rentalRequest).toMatchObject({ unit: "night", from: day(4) });
  });
});
