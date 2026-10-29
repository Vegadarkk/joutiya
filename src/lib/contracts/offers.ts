import { z } from "@/lib/zod";
import { stripFormatCharacters } from "@/lib/contracts/messaging";
import { startConversationRequestSchema } from "@/lib/contracts/rental-requests";
import { OFFER_NOTE_MAX, type OfferEvent, type OfferStatus } from "@/lib/offers/rules";

// Price offers in a conversation (Carte vivante lot 5): the buyer proposes an amount, the seller
// accepts, declines or counters once, the buyer withdraws or accepts the counter; 48 h to answer.
// One current offer per conversation, so per (listing, buyer), carried by the conversation
// document; every step is a system message of the thread. Shared by the browser (listing page
// dialog, thread card) and the route handler. Nothing is sold or paid through the site.

export * from "@/lib/offers/rules";

/** POST /api/conversations/{cid}/offer: OfferAction -> 201 OfferResponse. */
export const offerPath = (cid: string) => `/api/conversations/${cid}/offer`;

export const offerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);

/** Whole DH; the bounds depend on the listing's price (offerProblem), checked by the server. */
const amountSchema = z.number().int().positive().max(100_000_000);

/** Optional words with an offer: sent as an ordinary message after the step (masked, flagged, reportable). */
export const offerNoteSchema = z.preprocess(
  (value) => (typeof value === "string" ? stripFormatCharacters(value) : value),
  z
    .string()
    .trim()
    .max(OFFER_NOTE_MAX)
    .refine((text) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text), { message: "control_characters" })
    .refine((text) => !text.includes("⟦") && !text.includes("⟧"), { message: "reserved_marker" }),
);

/** The buyer's offer with the first message (the listing page's « Faire une offre »): the message is the note. */
export const offerInputSchema = z.object({ amount: amountSchema }).strict();
export type OfferInput = z.infer<typeof offerInputSchema>;

/** POST /api/conversations with a booking request (car rental) or an offer, never both. */
export const startConversationOfferSchema = startConversationRequestSchema
  .extend({ offer: offerInputSchema.optional() })
  .strict()
  .refine((input) => !(input.offer && input.rentalRequest), { message: "one_request", path: ["offer"] });
export type StartConversationWithOffer = z.infer<typeof startConversationOfferSchema>;

export const offerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("make"), amount: amountSchema, note: offerNoteSchema.optional() }).strict(),
  z.object({ action: z.literal("accept"), id: offerIdSchema }).strict(),
  z.object({ action: z.literal("decline"), id: offerIdSchema }).strict(),
  z.object({ action: z.literal("counter"), id: offerIdSchema, amount: amountSchema, note: offerNoteSchema.optional() }).strict(),
  z.object({ action: z.literal("withdraw"), id: offerIdSchema }).strict(),
]);
export type OfferAction = z.infer<typeof offerActionSchema>;

/** The conversation's current offer as its participant sees it. Dates are epoch ms. */
export interface OfferView {
  id: string;
  /** "expired" as soon as the 48 h are over, before the sweep writes it. */
  status: OfferStatus;
  /** I am the buyer (I made the offer). */
  madeByMe: boolean;
  /** The buyer's offer, DH. */
  amount: number;
  /** The seller's counter-offer, DH; null when none. */
  counter: number | null;
  /** The listing's price the bounds were measured against, DH. */
  price: number;
  /** End of the current 48 h (offer or counter-offer). */
  expiresAt: number;
  updatedAt: number;
}

/** The offer step a system message of the thread shows. */
export interface OfferEventView {
  event: OfferEvent;
  /** I took that step (meaningless for an expiry). */
  byMe: boolean;
  /** The amount of the step: the offer, the counter-offer, or the amount agreed on. */
  amount: number;
}

/** POST /api/conversations/{cid}/offer -> 201. */
export interface OfferResponse {
  offer: OfferView;
  messageId: string;
}
