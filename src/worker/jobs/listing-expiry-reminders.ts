import type { ListingRecord } from "@/lib/db/repositories/listings";
import { listListingsExpiringBetween, readReminderCursor, writeReminderCursor, type ListingCursor } from "@/lib/db/repositories/retention";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { recipientCache, siteUrl, type ListingRecipient } from "@/lib/mail/recipients";

// Nightly at 02:40 UTC (design D16): the listingExpiringSoon mail (bulk) to published listings
// expiring REMINDER_DAYS days ahead, at most once per expiry date. The window is a whole UTC day
// (D+3), and a cursor (system/listingReminders) records how far reminders went: a second run the
// same day sends nothing, a crashed run resumes after the last page it started, and a missed
// night is caught up (listings expiring sooner than 3 days are reminded late rather than never).
// The cursor moves before a page's mails are queued: a crash loses reminders, never doubles them.

export const REMINDER_DAYS = 3;
export const REMINDER_BATCH = 200;
export const REMINDER_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReminderResult {
  reminded: number;
  /** No address (closed or banned account, missing profile). */
  skipped: number;
  failed: number;
}

/** [start, end) of the expiry dates reminded by a run at `now`: the UTC day REMINDER_DAYS ahead. */
export function reminderWindow(now: Date): { start: Date; end: Date } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + REMINDER_DAYS);
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

/** Where this run starts: after the stored cursor, never before now (expired listings get no reminder). */
export function reminderStart(now: Date, stored: { through: Date; lastId: string | null } | null): { from: Date; cursor?: ListingCursor } {
  if (!stored) return { from: reminderWindow(now).start };
  if (stored.through.getTime() <= now.getTime()) return { from: now };
  return { from: stored.through, ...(stored.lastId ? { cursor: { at: stored.through, id: stored.lastId } } : {}) };
}

async function remind(listing: ListingRecord, recipients: (uid: string) => Promise<ListingRecipient | null>, result: ReminderResult): Promise<void> {
  if (!listing.expiresAt) return;
  try {
    const to = await recipients(listing.ownerUid);
    if (!to) {
      result.skipped += 1;
      return;
    }
    await sendMail({
      template: "listingExpiringSoon",
      locale: to.locale,
      to: to.email,
      data: {
        displayName: to.displayName,
        title: listing.title,
        url: siteUrl(to.locale, listing.slugId ? `annonce/${listing.slugId}` : "mes-annonces"),
        expiresAt: listing.expiresAt.toISOString(),
      },
      priority: "bulk",
      idempotencyKey: `listingExpiringSoon-${listing.id}-${listing.expiresAt.getTime()}`,
    });
    result.reminded += 1;
  } catch (error) {
    result.failed += 1;
    logger.warn({ listingId: listing.id, err: (error as Error).message }, "expiry reminder failed");
  }
}

export async function sendExpiryReminders(now = new Date()): Promise<ReminderResult> {
  const result: ReminderResult = { reminded: 0, skipped: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("listing-expiry-reminders skipped: Firebase not configured");
    return result;
  }
  const { end } = reminderWindow(now);
  const stored = await readReminderCursor();
  if (stored && stored.through.getTime() >= end.getTime()) {
    logger.info({ ...result }, "listing-expiry-reminders: window already done");
    return result;
  }
  const start = reminderStart(now, stored);
  const recipients = recipientCache();
  let cursor = start.cursor;
  let finished = false;
  for (let pages = 0; pages < REMINDER_PAGES && !finished; pages += 1) {
    const page = await listListingsExpiringBetween(start.from, end, REMINDER_BATCH, cursor);
    finished = !page.next || page.read < REMINDER_BATCH;
    await writeReminderCursor(finished || !page.next ? { through: end, lastId: null } : { through: page.next.at, lastId: page.next.id }, now);
    for (const listing of page.listings) await remind(listing, recipients, result);
    cursor = page.next;
  }
  logger.info({ ...result, complete: finished }, "listing-expiry-reminders");
  return result;
}
