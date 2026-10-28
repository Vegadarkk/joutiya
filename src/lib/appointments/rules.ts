import {
  APPOINTMENT_HORIZON_MS,
  APPOINTMENT_LEAD_MS,
  APPOINTMENT_REMINDERS_MS,
  type AppointmentStatus,
  type Slot,
} from "@/lib/contracts/appointments";

// Appointment rules shared by the slot picker and the server (pure): which slots may be proposed,
// when an appointment is still active, and when its next reminder is due.

export type SlotProblem = "too_soon" | "too_far" | "overlap" | "duplicate";

export const slotEnd = (slot: Slot) => slot.start + slot.minutes * 60_000;

export const sortSlots = (slots: readonly Slot[]): Slot[] => [...slots].sort((a, b) => a.start - b.start);

/** Why `slots` cannot be proposed at `now`, as [index in the given order, problem]; null when they can. */
export function slotsProblem(slots: readonly Slot[], now: number): [number, SlotProblem] | null {
  for (const [index, slot] of slots.entries()) {
    if (slot.start < now + APPOINTMENT_LEAD_MS) return [index, "too_soon"];
    if (slot.start > now + APPOINTMENT_HORIZON_MS) return [index, "too_far"];
  }
  for (const [index, slot] of slots.entries()) {
    for (const other of slots.slice(0, index)) {
      if (other.start === slot.start) return [index, "duplicate"];
      if (other.start < slotEnd(slot) && slot.start < slotEnd(other)) return [index, "overlap"];
    }
  }
  return null;
}

/** A proposal waits for an answer, a confirmed slot has not ended: a new proposal reschedules it. */
export function isActive(appointment: { status: AppointmentStatus; chosen?: Slot | null; slots: readonly Slot[] }, now: number): boolean {
  if (appointment.status === "proposed") return appointment.slots.some((slot) => slot.start > now);
  if (appointment.status === "confirmed") return appointment.chosen ? slotEnd(appointment.chosen) > now : false;
  return false;
}

/** Due time of the next reminder of a slot confirmed at `now` or reminded at `now`; null when none is left. */
export function nextReminderAt(slot: Slot, now: number): number | null {
  for (const before of APPOINTMENT_REMINDERS_MS) {
    const at = slot.start - before;
    if (at > now) return at;
  }
  return null;
}
