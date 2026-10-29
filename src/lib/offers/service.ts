import "server-only";
import { randomBytes } from "node:crypto";
import {
  OFFER_TTL_MS,
  offerFinalAmount,
  offerMarker,
  offerPending,
  offerProblem,
  offerStatusAt,
  type OfferAction,
  type OfferEvent,
  type OfferInput,
  type OfferResponse,
} from "@/lib/contracts/offers";
import { getListing } from "@/lib/db/repositories/listings";
import { offerSchema, type OfferDoc, type OfferEventDoc } from "@/lib/db/schemas";
import { HttpError, notFound } from "@/lib/http/errors";
import { ConversationAccessError, getParticipantConversation, type ConversationRecord } from "@/lib/messaging/repository";
import { appendSystemStep, sendMessage, type MessagingActor } from "@/lib/messaging/service";
import { assertOfferListing } from "./listing";
import { offerView } from "./views";

// Price offer steps (Carte vivante lot 5). The buyer (the conversation's buyer) makes an offer on
// a listing that takes offers, between 30 % of its price and the price, while none of his is
// pending; the seller accepts, declines or counters once (same bounds, above the offer); the buyer
// withdraws (an offer or a counter-offer) or accepts the counter-offer. 48 h to answer each time:
// past that the offer reads "expired" and the job offer-expiry writes it with its thread step.
// Each step is one system message appended in the message transaction (access checks of D4), so
// it reaches the other participant like a message (badge, live stream, digest mail with its
// opt-out). An optional note follows as an ordinary message, screened like any message. An
// accepted offer is no sale and no payment: nothing reaches Stripe, the card says so.

const newOfferId = () => randomBytes(9).toString("base64url");

const changed = () => new HttpError(409, "offer_changed");
const expired = () => new HttpError(409, "offer_expired");

function invalidAmount(problem: string): never {
  throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "amount", code: problem }] });
}

export type OfferRole = "buyer" | "seller";

export interface OfferStep {
  offer: OfferDoc;
  event: OfferEvent;
  /** The amount the step shows. */
  amount: number;
}

const pending = (offer: OfferDoc | undefined, at: number) => offer !== undefined && offerPending({ status: offer.status, expiresAt: offer.expiresAt.getTime() }, at);

/**
 * The next state of `current` after `action` by the participant in `role` at `now`; throws when the
 * action does not apply. `price`: the listing's offer price read for a new offer.
 */
export function nextOfferStep(current: OfferDoc | undefined, action: OfferAction, role: OfferRole, now: Date, price?: number): OfferStep {
  const at = now.getTime();
  if (action.action === "make") {
    if (role !== "buyer") throw new HttpError(403, "forbidden", "only the buyer makes an offer");
    if (pending(current, at)) throw new HttpError(409, "offer_pending");
    if (price === undefined) throw new HttpError(409, "offer_unavailable");
    const problem = offerProblem(action.amount, price);
    if (problem) invalidAmount(problem);
    const offer = offerSchema.parse({ id: newOfferId(), status: "open", amount: action.amount, price, createdAt: now, updatedAt: now, expiresAt: new Date(at + OFFER_TTL_MS) });
    return { offer, event: "made", amount: offer.amount };
  }
  if (!current || current.id !== action.id) throw changed();
  const status = offerStatusAt({ status: current.status, expiresAt: current.expiresAt.getTime() }, at);
  if (status === "expired" && (current.status === "open" || current.status === "countered")) throw expired();
  const base = { ...current, updatedAt: now };
  switch (action.action) {
    case "accept":
      if (role === "seller" && status === "open") return { offer: { ...base, status: "accepted" }, event: "accepted", amount: current.amount };
      if (role === "buyer" && status === "countered") return { offer: { ...base, status: "accepted" }, event: "accepted", amount: offerFinalAmount(current) };
      throw changed();
    case "decline":
      if (role !== "seller" || status !== "open") throw changed();
      return { offer: { ...base, status: "declined" }, event: "declined", amount: current.amount };
    case "counter": {
      if (role !== "seller" || status !== "open") throw changed();
      const problem = offerProblem(action.amount, current.price, current.amount);
      if (problem) invalidAmount(problem);
      return { offer: { ...base, status: "countered", counter: action.amount, expiresAt: new Date(at + OFFER_TTL_MS) }, event: "countered", amount: action.amount };
    }
    case "withdraw":
      if (role !== "buyer" || (status !== "open" && status !== "countered")) throw changed();
      return { offer: { ...base, status: "withdrawn" }, event: "withdrawn", amount: offerFinalAmount(current) };
  }
}

const roleOf = (conversation: Pick<ConversationRecord, "buyerUid">, uid: string): OfferRole => (conversation.buyerUid === uid ? "buyer" : "seller");

async function participantConversation(cid: string, uid: string): Promise<ConversationRecord> {
  try {
    return await getParticipantConversation(cid, uid);
  } catch (error) {
    if (error instanceof ConversationAccessError) throw notFound();
    throw error;
  }
}

/**
 * One offer step in `cid` by `actor` (the route handler authenticated, limited and gated it). A
 * new offer reads the conversation and its listing first (`price` when the caller has it: the first
 * message); a counter-offer keeps the bounds of the offer. The optional note follows as a message.
 */
export async function actOnOffer(actor: MessagingActor, cid: string, action: OfferAction, now = new Date(), price?: number): Promise<OfferResponse> {
  let offerPrice = price;
  if (action.action === "make" && offerPrice === undefined) {
    const conversation = await participantConversation(cid, actor.uid);
    // A seller never makes an offer: refused before the listing read.
    if (roleOf(conversation, actor.uid) !== "buyer") throw new HttpError(403, "forbidden", "only the buyer makes an offer");
    if (pending(conversation.offer, now.getTime())) throw new HttpError(409, "offer_pending");
    offerPrice = assertOfferListing(await getListing(conversation.listingId), now);
  }
  let result: { offer: OfferDoc; role: OfferRole } | undefined;
  const messageId = await appendSystemStep(
    actor,
    cid,
    (conversation) => {
      const role = roleOf(conversation, actor.uid);
      const step = nextOfferStep(conversation.offer, action, role, now, offerPrice);
      result = { offer: step.offer, role };
      const offer: OfferEventDoc = { id: step.offer.id, event: step.event, amount: step.amount };
      const waiting = step.offer.status === "open" || step.offer.status === "countered";
      return { fields: { offer: step.offer, offerExpiresAt: waiting ? step.offer.expiresAt : null }, message: { text: offerMarker(step.event), offer } };
    },
    now,
  );
  if (!result) throw new Error("offer step without a result");
  const note = action.action === "make" || action.action === "counter" ? action.note?.trim() : undefined;
  // The note reads after the step (one millisecond later), screened like every message.
  if (note) await sendMessage(actor, cid, note, new Date(now.getTime() + 1));
  return { offer: offerView(result.offer, result.role === "buyer", now.getTime()), messageId };
}

/** The first message's offer (POST /api/conversations with `offer`). */
export function makeAction(input: OfferInput): OfferAction {
  return { action: "make", amount: input.amount };
}
