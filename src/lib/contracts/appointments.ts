import { z } from "@/lib/zod";
import { stripFormatCharacters } from "@/lib/contracts/messaging";

// Appointments in a conversation (architecture §5, 28 Oct): one participant proposes 1 to 5 time
// slots for a visit, a test drive, a pickup or a meeting, the other picks one or declines. One
// active appointment per conversation, carried by the conversation document; every step is a
// system message of the thread. Shared by the browser (slot picker, cards) and the route handler.
// The Concession (test drive) and Agence (visit) packs reuse these kinds and components.

/** Extend at the end; labels in messages/*.json under Appointments.kind. */
export const APPOINTMENT_KINDS = ["meeting", "visit", "test_drive", "pickup"] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

export const APPOINTMENT_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
export type AppointmentDuration = (typeof APPOINTMENT_DURATIONS)[number];

export const APPOINTMENT_SLOTS_MAX = 5;
export const APPOINTMENT_PLACE_MAX = 120;
/** A slot starts on a quarter hour. */
export const APPOINTMENT_STEP_MS = 15 * 60_000;
/** Earliest start of a proposed slot, from now. */
export const APPOINTMENT_LEAD_MS = 60 * 60_000;
/** Latest start of a proposed slot, from now. */
export const APPOINTMENT_HORIZON_MS = 60 * 24 * 60 * 60_000;
/** Reminders before a confirmed slot: the day before, then two hours before. */
export const APPOINTMENT_REMINDERS_MS = [24 * 60 * 60_000, 2 * 60 * 60_000] as const;

export const APPOINTMENT_STATUSES = ["proposed", "confirmed", "declined", "withdrawn", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** What a system message of the thread says about the appointment. */
export const APPOINTMENT_EVENTS = ["proposed", "rescheduled", "confirmed", "declined", "withdrawn", "cancelled", "reminder"] as const;
export type AppointmentEvent = (typeof APPOINTMENT_EVENTS)[number];

export const APPOINTMENT_CANCEL_REASONS = ["unavailable", "sold", "other"] as const;
export type AppointmentCancelReason = (typeof APPOINTMENT_CANCEL_REASONS)[number];

/** Stored text of an appointment system message: the UI renders it localized (inbox preview too). */
export const appointmentMarker = (event: AppointmentEvent) => `⟦rdv:${event}⟧`;
const MARKER = /^⟦rdv:([a-z_]+)⟧$/;

/** The event of an appointment marker text, else null. */
export function appointmentEventOf(text: string): AppointmentEvent | null {
  const event = MARKER.exec(text)?.[1];
  return (APPOINTMENT_EVENTS as readonly string[]).includes(event ?? "") ? (event as AppointmentEvent) : null;
}

export const appointmentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);

export const slotSchema = z
  .object({
    /** Epoch ms, on a quarter hour. */
    start: z.number().int().positive().refine((start) => start % APPOINTMENT_STEP_MS === 0, { message: "not_on_quarter_hour" }),
    minutes: z.literal(APPOINTMENT_DURATIONS),
  })
  .strict();
export type Slot = z.infer<typeof slotSchema>;

const placeSchema = z.preprocess(
  (value) => (typeof value === "string" ? stripFormatCharacters(value) : value),
  z
    .string()
    .trim()
    .max(APPOINTMENT_PLACE_MAX)
    // One line, no control characters, the markers are the server's.
    .refine((text) => !/[\u0000-\u001F\u007F]/.test(text), { message: "control_characters" })
    .refine((text) => !text.includes("⟦") && !text.includes("⟧"), { message: "reserved_marker" }),
);

export const appointmentActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("propose"),
      kind: z.enum(APPOINTMENT_KINDS),
      slots: z.array(slotSchema).min(1).max(APPOINTMENT_SLOTS_MAX),
      place: placeSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("confirm"), id: appointmentIdSchema, start: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("decline"), id: appointmentIdSchema }).strict(),
  z.object({ action: z.literal("withdraw"), id: appointmentIdSchema }).strict(),
  z.object({ action: z.literal("cancel"), id: appointmentIdSchema, reason: z.enum(APPOINTMENT_CANCEL_REASONS).optional() }).strict(),
]);
export type AppointmentAction = z.infer<typeof appointmentActionSchema>;

/** The appointment of a conversation as its participant sees it. Dates are epoch ms. */
export interface AppointmentView {
  id: string;
  kind: AppointmentKind;
  status: AppointmentStatus;
  proposedByMe: boolean;
  /** Sorted by start. */
  slots: Slot[];
  /** The confirmed slot (also kept after a cancellation). */
  chosen: Slot | null;
  /** Links masked (URL_MARKER). */
  place: string | null;
  cancelledByMe: boolean | null;
  reason: AppointmentCancelReason | null;
  updatedAt: number;
}

/** The appointment step a system message of the thread shows. */
export interface AppointmentEventView {
  event: AppointmentEvent;
  kind: AppointmentKind;
  /** I took that step (meaningless for a reminder). */
  byMe: boolean;
  /** The confirmed or cancelled slot, the slot a reminder is about. */
  slot: Slot | null;
  reason: AppointmentCancelReason | null;
}

/** POST /api/conversations/{cid}/appointment -> 201. */
export interface AppointmentResponse {
  appointment: AppointmentView;
  messageId: string;
}
