import type { AppointmentEventView, AppointmentView, Slot } from "@/lib/contracts/appointments";
import type { AppointmentDoc, AppointmentEventDoc, StoredSlot } from "@/lib/db/schemas";

// What a participant sees of the conversation's appointment and of its system messages.

const slotView = (slot: StoredSlot): Slot => ({ start: slot.start.getTime(), minutes: slot.minutes });

export function appointmentView(appointment: AppointmentDoc, uid: string): AppointmentView {
  return {
    id: appointment.id,
    kind: appointment.kind,
    status: appointment.status,
    proposedByMe: appointment.proposedBy === uid,
    slots: appointment.slots.map(slotView),
    chosen: appointment.chosen ? slotView(appointment.chosen) : null,
    place: appointment.place ?? null,
    cancelledByMe: appointment.cancelledBy === undefined ? null : appointment.cancelledBy === uid,
    reason: appointment.reason ?? null,
    updatedAt: appointment.updatedAt.getTime(),
  };
}

export function appointmentEventView(step: AppointmentEventDoc, byMe: boolean): AppointmentEventView {
  return { event: step.event, kind: step.kind, byMe, slot: step.slot ? slotView(step.slot) : null, reason: step.reason ?? null };
}
