// What a member wrote in a stored message (audit A-02), the part a notice or a moderation decision
// is about: a text message's text, or the place of a system step that carries one (an appointment
// proposal or rescheduling, a booking request). Other system steps carry no member text: they
// cannot be reported. Reads raw document data or a parsed message alike. Pure.

export type MemberTextField = "text" | "appointment.place" | "rentalRequest.pickup";

export interface MemberText {
  /** Firestore field path of the text in the message document. */
  field: MemberTextField;
  text: string;
}

interface LooseMessage {
  type?: unknown;
  text?: unknown;
  appointment?: unknown;
  rentalRequest?: unknown;
}

const PLACE_EVENTS: Record<"appointment" | "rentalRequest", readonly string[]> = {
  appointment: ["proposed", "rescheduled"],
  rentalRequest: ["requested", "changed"],
};

function stepPlace(step: unknown, events: readonly string[], key: "place" | "pickup"): string | null {
  if (typeof step !== "object" || step === null) return null;
  const { event, [key]: value } = step as Record<string, unknown>;
  return typeof event === "string" && events.includes(event) && typeof value === "string" && value.length > 0 ? value : null;
}

/** The member text of a message, or null (a system step without one, a malformed document). */
export function memberTextOf(message: LooseMessage): MemberText | null {
  if (message.type === "text") return typeof message.text === "string" ? { field: "text", text: message.text } : null;
  if (message.type !== "system") return null;
  const place = stepPlace(message.appointment, PLACE_EVENTS.appointment, "place");
  if (place !== null) return { field: "appointment.place", text: place };
  const pickup = stepPlace(message.rentalRequest, PLACE_EVENTS.rentalRequest, "pickup");
  return pickup !== null ? { field: "rentalRequest.pickup", text: pickup } : null;
}

const STAFF_LABELS: Record<Exclude<MemberTextField, "text">, string> = {
  "appointment.place": "Lieu du rendez-vous proposé",
  "rentalRequest.pickup": "Lieu de prise en charge demandé",
};

/**
 * The member text as staff and the moderation assistant read it (French): a text as is, a place
 * with what it is. Null when the message has none (a system step, or one whose place is hidden).
 */
export function staffMemberText(message: LooseMessage): string | null {
  const member = memberTextOf(message);
  if (!member) return null;
  return member.field === "text" ? member.text : `${STAFF_LABELS[member.field]} : ${member.text}`;
}

/** The label of a hidden step's place for staff (its original is in the evidence), null for a text message. */
export function staffPlaceLabel(message: LooseMessage): string | null {
  if (message.type !== "system") return null;
  if (typeof message.appointment === "object" && message.appointment !== null) return STAFF_LABELS["appointment.place"];
  if (typeof message.rentalRequest === "object" && message.rentalRequest !== null) return STAFF_LABELS["rentalRequest.pickup"];
  return null;
}
