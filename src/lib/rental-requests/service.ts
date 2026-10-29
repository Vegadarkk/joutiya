import "server-only";
import { randomBytes } from "node:crypto";
import { datedRental, type RentalUnit } from "@/config/categories";
import { rentalRequestMarker, rentalRequestProblem, type RentalRequestAction, type RentalRequestEvent, type RentalRequestInput, type RentalRequestResponse } from "@/lib/contracts/rental-requests";
import { getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { rentalRequestSchema, type RentalRequestDoc, type RentalRequestEventDoc } from "@/lib/db/schemas";
import { HttpError, notFound } from "@/lib/http/errors";
import { blockRentalDates } from "@/lib/listings/availability";
import { acceptsContact } from "@/lib/listings/public";
import { dayNumber, dayString, moroccoToday, type RentalPeriod } from "@/lib/listings/rental-availability";
import { ConversationAccessError, getParticipantConversation, type ConversationRecord } from "@/lib/messaging/repository";
import { screenPlace } from "@/lib/messaging/place";
import { appendSystemStep, type MessagingActor } from "@/lib/messaging/service";
import { rentalRequestView } from "./views";

// Booking request steps of a car rental (rental pack §6), and of a holiday home's stay by nights
// (seasonal rental conception §3: arrival and departure, the host answers). The renter (the conversation's buyer)
// asks for a period and a pick-up place, or replaces an unanswered request; the agency (the seller)
// accepts, writing the days on the listing as unavailable when asked first, or declines; the renter
// may withdraw an unanswered request. Each step is one system message appended in the message
// transaction (access checks of D4), so it reaches the other participant like a message. Nothing
// is booked or paid through the site: the card says the agency's written contract concludes it.

const newRequestId = () => randomBytes(9).toString("base64url");

const changed = () => new HttpError(409, "rental_request_changed");

function invalidDates(problem: string): never {
  throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "from", code: problem }] });
}

export type RentalRole = "buyer" | "seller";

export interface RentalStep {
  request: RentalRequestDoc;
  event: RentalRequestEvent;
}

export interface RentalStepOptions {
  /** accept: the days were written on the listing. */
  blocked?: boolean;
  /** request: the listing's unit (a holiday home is rented by nights). */
  unit?: RentalUnit;
}

/** The next state of `current` after `action` by the participant in `role` at `now`; throws when the action does not apply. */
export function nextRentalStep(current: RentalRequestDoc | undefined, action: RentalRequestAction, role: RentalRole, now: Date, { blocked = false, unit = "day" }: RentalStepOptions = {}): RentalStep {
  const today = moroccoToday(now);
  if (action.action === "request") {
    if (role !== "buyer") throw new HttpError(403, "forbidden", "only the renter sends a booking request");
    const problem = rentalRequestProblem(action, today, unit);
    if (problem) invalidDates(problem);
    const pickup = action.pickup ? screenPlace(action.pickup) : undefined;
    const request = rentalRequestSchema.parse({
      id: newRequestId(),
      status: "requested",
      from: action.from,
      to: action.to,
      ...(unit === "night" ? { unit } : {}),
      ...(pickup ? { pickup } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return { request, event: current?.status === "requested" ? "changed" : "requested" };
  }
  if (!current || current.id !== action.id || current.status !== "requested") throw changed();
  const base = { ...current, updatedAt: now };
  switch (action.action) {
    case "accept":
      if (role !== "seller") throw changed();
      if (today > dayNumber(current.from)) throw new HttpError(409, "rental_request_past");
      return { request: { ...base, status: "accepted", ...(blocked ? { blocked: true } : {}) }, event: "accepted" };
    case "decline":
      if (role !== "seller") throw changed();
      return { request: { ...base, status: "declined" }, event: "declined" };
    case "withdraw":
      if (role !== "buyer") throw changed();
      return { request: { ...base, status: "withdrawn" }, event: "withdrawn" };
  }
}

const roleOf = (conversation: Pick<ConversationRecord, "buyerUid">, uid: string): RentalRole => (conversation.buyerUid === uid ? "buyer" : "seller");

/** The unit of the listing a booking request is about: a published car rental or holiday home that takes contact, else 409. */
export function rentalListingUnit(listing: ListingRecord | null): RentalUnit {
  const rental = datedRental(listing?.subcategoryId);
  if (!listing || !rental || listing.status !== "published" || listing.moderation.hiddenBy || !acceptsContact(listing)) {
    throw new HttpError(409, "rental_request_unavailable");
  }
  return rental.unit;
}

/** The listing days a request takes: a stay's nights leave its departure day free. */
export function requestedPeriod(request: Pick<RentalRequestDoc, "from" | "to" | "unit">): RentalPeriod {
  return request.unit === "night" ? { from: request.from, to: dayString(dayNumber(request.to) - 1) } : { from: request.from, to: request.to };
}

async function participantConversation(cid: string, uid: string): Promise<ConversationRecord> {
  try {
    return await getParticipantConversation(cid, uid);
  } catch (error) {
    if (error instanceof ConversationAccessError) throw notFound();
    throw error;
  }
}

/**
 * One booking request step in `cid` by `actor` (the route handler authenticated, limited and gated
 * it). A request reads the conversation and its listing first (`listing` when the caller has it:
 * the first message); an acceptance with `block` writes the days on the listing before its message,
 * and records whether that worked.
 */
export async function actOnRentalRequest(actor: MessagingActor, cid: string, action: RentalRequestAction, now = new Date(), listing?: ListingRecord): Promise<RentalRequestResponse> {
  let blocked: boolean | null = null;
  let unit: RentalUnit = "day";
  if (action.action === "request") {
    if (!listing) {
      const conversation = await participantConversation(cid, actor.uid);
      listing = (await getListing(conversation.listingId)) ?? undefined;
    }
    unit = rentalListingUnit(listing ?? null);
  } else if (action.action === "accept" && action.block) {
    const conversation = await participantConversation(cid, actor.uid);
    const current = conversation.rentalRequest;
    // Checked again in the transaction; the days are only written for a request still open.
    nextRentalStep(current, action, roleOf(conversation, actor.uid), now);
    if (current) blocked = await blockRentalDates(actor, conversation.listingId, requestedPeriod(current), now);
  }
  let result: { request: RentalRequestDoc; role: RentalRole } | undefined;
  const messageId = await appendSystemStep(
    actor,
    cid,
    (conversation) => {
      const role = roleOf(conversation, actor.uid);
      const step = nextRentalStep(conversation.rentalRequest, action, role, now, { blocked: blocked === true, unit });
      result = { request: step.request, role };
      const rentalRequest: RentalRequestEventDoc = {
        id: step.request.id,
        event: step.event,
        from: step.request.from,
        to: step.request.to,
        ...(step.request.unit ? { unit: step.request.unit } : {}),
        // The renter's own words travel with the request only: that message is the one a member reports (A-02).
        ...(step.request.pickup && (step.event === "requested" || step.event === "changed") ? { pickup: step.request.pickup } : {}),
      };
      return { fields: { rentalRequest: step.request }, message: { text: rentalRequestMarker(step.event), rentalRequest } };
    },
    now,
  );
  if (!result) throw new Error("rental request step without a result");
  return { rentalRequest: rentalRequestView(result.request, result.role === "buyer"), messageId, blocked };
}

/** The first message's request (POST /api/conversations with `rentalRequest`). */
export function requestAction(input: RentalRequestInput): RentalRequestAction {
  return { action: "request", from: input.from, to: input.to, ...(input.pickup ? { pickup: input.pickup } : {}) };
}
