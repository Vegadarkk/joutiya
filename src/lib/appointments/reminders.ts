import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { appointmentMarker } from "@/lib/contracts/appointments";
import { COLLECTIONS, messageSchema, type AppointmentDoc, type MessageDoc } from "@/lib/db/schemas";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { conversationFromSnapshot, conversationRef, messagesRef, type ConversationRecord } from "@/lib/messaging/repository";
import { nextReminderAt } from "./rules";

// Reminders of confirmed appointments (job appointment-reminders): conversations whose
// `appointmentRemindAt` is due, read by a single-field range query (automatic index). Each one is
// re-read in a transaction: a reminder still due and still valid (confirmed, slot ahead, the pair
// can still write to each other) becomes a system message of the thread, without touching the
// inbox order or the unread counts, and `appointmentRemindAt` moves to the next reminder or goes.

export const REMINDER_BATCH = 50;

/** Conversations with a reminder due at `now`, oldest due first. */
export async function listDueReminders(now: Date, limit = REMINDER_BATCH): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.conversations).where("appointmentRemindAt", "<=", now).orderBy("appointmentRemindAt").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map((doc) => doc.id);
}

export interface RecordedReminder {
  conversation: ConversationRecord;
  appointment: AppointmentDoc & { chosen: NonNullable<AppointmentDoc["chosen"]> };
  messageId: string;
}

/** Still worth a reminder: confirmed, slot ahead, open, nobody blocked, no account closed. */
function remindable(conversation: ConversationRecord, now: Date): conversation is ConversationRecord & { appointment: RecordedReminder["appointment"] } {
  const appointment = conversation.appointment;
  return (
    appointment?.status === "confirmed" &&
    appointment.chosen !== undefined &&
    appointment.chosen.start.getTime() > now.getTime() &&
    conversation.status === "open" &&
    conversation.blockedBy.length === 0 &&
    (conversation.accountClosed ?? []).length === 0
  );
}

/**
 * The due reminder of `cid` as a system message; null when it is not due any more (another run
 * took it) or not valid (then `appointmentRemindAt` is cleared).
 */
export async function recordReminder(cid: string, now: Date): Promise<RecordedReminder | null> {
  const messageRef = messagesRef(cid).doc();
  const outcome = await db().runTransaction(async (tx) => {
    const conversation = conversationFromSnapshot(await tx.get(conversationRef(cid)));
    if (!conversation?.appointmentRemindAt || conversation.appointmentRemindAt.getTime() > now.getTime()) return null;
    if (!remindable(conversation, now)) {
      tx.update(conversationRef(cid), { appointmentRemindAt: FieldValue.delete() });
      return { cleared: true as const };
    }
    const { appointment } = conversation;
    const message: MessageDoc = messageSchema.parse({
      senderUid: appointment.proposedBy,
      participants: conversation.participants,
      ...(conversation.sellerProId ? { sellerProId: conversation.sellerProId } : {}),
      type: "system",
      text: appointmentMarker("reminder"),
      appointment: { id: appointment.id, event: "reminder", kind: appointment.kind, slot: appointment.chosen },
      createdAt: now,
    });
    const next = nextReminderAt({ start: appointment.chosen.start.getTime(), minutes: appointment.chosen.minutes }, now.getTime());
    tx.set(messageRef, datesToTimestamps(message) as Record<string, unknown>);
    tx.update(conversationRef(cid), {
      appointmentRemindAt: next === null ? FieldValue.delete() : new Date(next),
      messageCount: FieldValue.increment(1),
    });
    return { conversation, appointment };
  });
  void consume("firestore.reads", 1);
  if (!outcome) return null;
  if ("cleared" in outcome) {
    void consume("firestore.writes", 1);
    return null;
  }
  void consume("firestore.writes", 2);
  return { ...outcome, messageId: messageRef.id };
}
