import { listDueReminders, recordReminder, type RecordedReminder } from "@/lib/appointments/reminders";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { publishEvents } from "@/lib/messaging/events";
import { isDegraded } from "@/lib/quota";

// Every 10 minutes (architecture §5, 28 Oct): reminders of confirmed appointments, the day before
// and two hours before the slot. Each due conversation gets a reminder system message (live event
// to both participants, no unread count) and an appointmentReminder mail to each participant who
// still has an address and did not turn the messaging mails off. At most REMINDER_BATCH a run; a
// late run still reminds while the slot is ahead. Stops while the Firestore write quota is
// degraded (the reminders wait for the reset).

export interface AppointmentReminderResult {
  due: number;
  reminded: number;
  /** Not due any more, or no longer valid (cancelled, blocked, frozen, slot passed). */
  skipped: number;
  mails: number;
  failed: number;
  stopped?: "quota";
}

const STOP_QUOTAS = ["firestore.writes", "firestore.reads"] as const;

async function mailParticipant(reminder: RecordedReminder, uid: string): Promise<boolean> {
  const { conversation, appointment } = reminder;
  const [user, account] = await Promise.all([getUserRecord(uid), getUserPrivate(uid)]);
  if (!user || !account?.email || user.status === "closed" || user.status === "banned") return false;
  if (account.notifications?.messagesEmail === false) return false;
  const buyer = conversation.buyerUid === uid;
  await sendMail({
    template: "appointmentReminder",
    locale: user.locale,
    to: account.email,
    data: {
      displayName: user.displayName,
      counterpartName: buyer ? conversation.sellerName : conversation.buyerName,
      listingTitle: conversation.listingSnapshot.title,
      kind: appointment.kind,
      startsAt: appointment.chosen.start.toISOString(),
      minutes: appointment.chosen.minutes,
      place: appointment.place ?? null,
      cid: conversation.cid,
    },
    priority: "transactional",
    idempotencyKey: `appointmentReminder-${conversation.cid}-${reminder.messageId}-${uid}`,
  });
  return true;
}

export async function sendAppointmentReminders(now = new Date()): Promise<AppointmentReminderResult> {
  const result: AppointmentReminderResult = { due: 0, reminded: 0, skipped: 0, mails: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("appointment-reminders skipped: Firebase not configured");
    return result;
  }
  for (const id of STOP_QUOTAS) {
    if (!(await isDegraded(id))) continue;
    logger.info({ quota: id }, "appointment-reminders skipped: quota degraded");
    return { ...result, stopped: "quota" };
  }
  const due = await listDueReminders(now);
  result.due = due.length;
  for (const cid of due) {
    let reminder: RecordedReminder | null;
    try {
      reminder = await recordReminder(cid, now);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "appointment reminder failed");
      result.failed += 1;
      continue;
    }
    if (!reminder) {
      result.skipped += 1;
      continue;
    }
    result.reminded += 1;
    const at = now.getTime();
    await publishEvents(reminder.conversation.participants.map((uid) => ({ uid, event: { type: "message", cid, mid: reminder.messageId, at } })));
    for (const uid of reminder.conversation.participants) {
      try {
        if (await mailParticipant(reminder, uid)) result.mails += 1;
      } catch (error) {
        // The in-app reminder stands; the mail is lost rather than sent twice.
        logger.warn({ err: (error as Error).message }, "appointment reminder mail not queued");
        result.failed += 1;
      }
    }
  }
  logger.info({ ...result }, "appointment-reminders");
  return result;
}
