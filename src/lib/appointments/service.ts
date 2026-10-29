import "server-only";
import { randomBytes } from "node:crypto";
import { appointmentMarker, type AppointmentAction, type AppointmentEvent, type AppointmentResponse } from "@/lib/contracts/appointments";
import { appointmentSchema, type AppointmentDoc, type AppointmentEventDoc, type StoredSlot } from "@/lib/db/schemas";
import { HttpError } from "@/lib/http/errors";
import { appendSystemStep, type MessagingActor } from "@/lib/messaging/service";
import { screenPlace } from "@/lib/messaging/place";
import { isActive, nextReminderAt, slotsProblem, sortSlots } from "./rules";
import { appointmentView } from "./views";

// Appointment steps (architecture §5, 28 Oct). Either participant proposes 1 to 5 slots; the other
// confirms one or declines; the proposer may withdraw an unanswered proposal; either one cancels a
// confirmed slot; a new proposal while one is active reschedules it. Each step is one system
// message appended in the message transaction (access checks of D4: participant, not blocked, not
// frozen, no closed account), so it counts as unread for the other participant and reaches him
// like a message. A confirmed slot gets reminders (job appointment-reminders). No payment ever
// goes through the platform: the cards only carry a safety note.

const newAppointmentId = () => randomBytes(9).toString("base64url");

const changed = () => new HttpError(409, "appointment_changed");

function invalidSlot(index: number, problem: string): never {
  throw new HttpError(400, "invalid_body", undefined, { details: [{ path: `slots.${index}`, code: problem }] });
}

const stored = (slot: { start: number; minutes: StoredSlot["minutes"] }): StoredSlot => ({ start: new Date(slot.start), minutes: slot.minutes });

interface Step {
  appointment: AppointmentDoc;
  event: AppointmentEvent;
  slot?: StoredSlot;
  remindAt: Date | null;
}

/**
 * The next state of `current` after `action` by `uid` at `now`; throws when the action does not apply.
 * `sellerUid` is the conversation's seller: only the seller cancels because the item is gone (#167).
 */
export function nextStep(current: AppointmentDoc | undefined, action: AppointmentAction, uid: string, now: Date, sellerUid?: string): Step {
  const at = now.getTime();
  if (action.action === "propose") {
    const slots = sortSlots(action.slots);
    const problem = slotsProblem(action.slots, at);
    if (problem) invalidSlot(...problem);
    const place = action.place ? screenPlace(action.place) : undefined;
    const rescheduled = current !== undefined && isActive(viewOf(current), at);
    const appointment = appointmentSchema.parse({
      id: newAppointmentId(),
      kind: action.kind,
      proposedBy: uid,
      slots: slots.map(stored),
      ...(place ? { place } : {}),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    return { appointment, event: rescheduled ? "rescheduled" : "proposed", remindAt: null };
  }
  if (!current || current.id !== action.id) throw changed();
  const base = { ...current, updatedAt: now };
  switch (action.action) {
    case "confirm": {
      if (current.status !== "proposed" || current.proposedBy === uid) throw changed();
      const slot = current.slots.find((item) => item.start.getTime() === action.start);
      if (!slot) throw changed();
      if (slot.start.getTime() <= at) throw new HttpError(409, "appointment_slot_past");
      const next = nextReminderAt({ start: slot.start.getTime(), minutes: slot.minutes }, at);
      return { appointment: { ...base, status: "confirmed", chosen: slot }, event: "confirmed", slot, remindAt: next === null ? null : new Date(next) };
    }
    case "decline":
      if (current.status !== "proposed" || current.proposedBy === uid) throw changed();
      return { appointment: { ...base, status: "declined" }, event: "declined", remindAt: null };
    case "withdraw":
      if (current.status !== "proposed" || current.proposedBy !== uid) throw changed();
      return { appointment: { ...base, status: "withdrawn" }, event: "withdrawn", remindAt: null };
    case "cancel": {
      if (current.status !== "confirmed" || !current.chosen || !isActive(viewOf(current), at)) throw changed();
      if (action.reason === "sold" && sellerUid !== undefined && uid !== sellerUid) throw new HttpError(403, "forbidden", "only the seller cancels because the item is gone");
      const appointment: AppointmentDoc = { ...base, status: "cancelled", cancelledBy: uid, ...(action.reason ? { reason: action.reason } : {}) };
      return { appointment, event: "cancelled", slot: current.chosen, remindAt: null };
    }
  }
}

function viewOf(appointment: AppointmentDoc) {
  return {
    status: appointment.status,
    slots: appointment.slots.map((slot) => ({ start: slot.start.getTime(), minutes: slot.minutes })),
    chosen: appointment.chosen ? { start: appointment.chosen.start.getTime(), minutes: appointment.chosen.minutes } : null,
  };
}

/** One appointment step in `cid` by `actor` (the route handler authenticated, limited and gated it). */
export async function actOnAppointment(actor: MessagingActor, cid: string, action: AppointmentAction, now = new Date()): Promise<AppointmentResponse> {
  let result: AppointmentDoc | undefined;
  const messageId = await appendSystemStep(
    actor,
    cid,
    (conversation) => {
      const step = nextStep(conversation.appointment, action, actor.uid, now, conversation.sellerUid);
      result = step.appointment;
      const appointment: AppointmentEventDoc = {
        id: step.appointment.id,
        event: step.event,
        kind: step.appointment.kind,
        ...(step.slot ? { slot: step.slot } : {}),
        // The proposer's own words travel with the proposal only: that message is the one a member reports (A-02).
        ...(step.appointment.place && (step.event === "proposed" || step.event === "rescheduled") ? { place: step.appointment.place } : {}),
        ...(step.appointment.reason && step.event === "cancelled" ? { reason: step.appointment.reason } : {}),
      };
      return {
        fields: { appointment: step.appointment, appointmentRemindAt: step.remindAt },
        message: { text: appointmentMarker(step.event), appointment },
      };
    },
    now,
  );
  if (!result) throw new Error("appointment step without a result");
  return { appointment: appointmentView(result, actor.uid), messageId };
}
