import { z } from "@/lib/zod";
import { startConversationSchema, stripFormatCharacters } from "@/lib/contracts/messaging";
import { DAY_PATTERN } from "@/lib/listings/rental-availability";
import type { RentalUnit } from "@/config/categories";
import { RENTAL_PICKUP_MAX, type RentalRequestEvent, type RentalRequestStatus } from "@/lib/rental-requests/rules";

// Booking requests of a car rental in a conversation (rental pack §6): the renter asks for a
// period (pick-up and return days, Morocco's calendar) and a pick-up place; the agency answers
// "available" (optionally blocking the days on the listing) or "not available"; the renter may
// withdraw an unanswered request or send another one. A holiday home's stay (seasonal rental
// conception §3) takes the same steps by nights: arrival and departure days, a free note instead
// of the pick-up place, the host (an individual or an agency) answers. One current request per conversation,
// carried by the conversation document; every step is a system message of the thread. Nothing is
// booked or paid through the site: the rental is concluded by the agency's written contract.

export * from "@/lib/rental-requests/rules";

export const rentalRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);

const pickupSchema = z.preprocess(
  (value) => (typeof value === "string" ? stripFormatCharacters(value) : value),
  z
    .string()
    .trim()
    .max(RENTAL_PICKUP_MAX)
    // One line, no control characters, the markers are the server's.
    .refine((text) => !/[\u0000-\u001F\u007F]/.test(text), { message: "control_characters" })
    .refine((text) => !text.includes("⟦") && !text.includes("⟧"), { message: "reserved_marker" }),
);

/** The renter's request, with the first message or from the thread. */
export const rentalRequestInputSchema = z.object({ from: z.string().regex(DAY_PATTERN), to: z.string().regex(DAY_PATTERN), pickup: pickupSchema.optional() }).strict();
export type RentalRequestInput = z.infer<typeof rentalRequestInputSchema>;

/** POST /api/conversations with a car rental's booking request (the listing page's "Demander une réservation"). */
export const startConversationRequestSchema = startConversationSchema.extend({ rentalRequest: rentalRequestInputSchema.optional() }).strict();
export type StartConversationWithRequest = z.infer<typeof startConversationRequestSchema>;

export const rentalRequestActionSchema = z.discriminatedUnion("action", [
  rentalRequestInputSchema.extend({ action: z.literal("request") }).strict(),
  /** `block`: the agency writes the days on the listing as unavailable (every vehicle of the model taken). */
  z.object({ action: z.literal("accept"), id: rentalRequestIdSchema, block: z.boolean() }).strict(),
  z.object({ action: z.literal("decline"), id: rentalRequestIdSchema }).strict(),
  z.object({ action: z.literal("withdraw"), id: rentalRequestIdSchema }).strict(),
]);
export type RentalRequestAction = z.infer<typeof rentalRequestActionSchema>;

/** The conversation's current request as its participant sees it. */
export interface RentalRequestView {
  id: string;
  status: RentalRequestStatus;
  /** I am the renter (the conversation's buyer). */
  requestedByMe: boolean;
  /** "YYYY-MM-DD", Morocco's calendar: pick-up and return days, or a stay's arrival and departure. */
  from: string;
  to: string;
  /** day: a car rental; night: a holiday home's stay. */
  unit: RentalUnit;
  /** Links masked (URL_MARKER). A stay's note (travellers, arrival time). */
  pickup: string | null;
  /** Accepted with the days blocked on the listing. */
  blocked: boolean;
  updatedAt: number;
}

/** The request step a system message of the thread shows. */
export interface RentalRequestEventView {
  event: RentalRequestEvent;
  /** I took that step. */
  byMe: boolean;
  from: string;
  to: string;
  unit: RentalUnit;
  pickup: string | null;
}

/** POST /api/conversations/{cid}/rental-request -> 201. */
export interface RentalRequestResponse {
  rentalRequest: RentalRequestView;
  messageId: string;
  /** accept with `block`: false when the days could not be written (too many periods); null otherwise. */
  blocked: boolean | null;
}
