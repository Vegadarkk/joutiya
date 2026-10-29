import "server-only";
import type { MessageRiskFlag } from "@/lib/contracts/messaging";
import { HttpError } from "@/lib/http/errors";
import { analyzeMessage, type MessageKeywords } from "./risk";

// A place a member writes outside the chat (appointment `place`, rental `pickup`; audit A-02): the
// message screen (D5) runs on it. Links are masked like in a message; bank details and payment
// terms are refused outright, since a meeting place never needs them and the text would reach the
// card, the reminder mails and the calendar file without the chat's warning. The chat stays the
// place to talk money, where the warning shows.

/** Flags of the message screen that make a place refused. */
export const PLACE_REFUSED_FLAGS: readonly MessageRiskFlag[] = ["iban", "payment_kw", "contact_with_payment_kw"];

/** The place as stored (links masked); throws 422 `place_payment_details` on bank details or payment terms. `keywords`: config/abuse lists. */
export function screenPlace(raw: string, keywords?: MessageKeywords): string {
  const { text, flags } = analyzeMessage(raw, keywords);
  if (flags.some((flag) => PLACE_REFUSED_FLAGS.includes(flag))) throw new HttpError(422, "place_payment_details");
  return text;
}
