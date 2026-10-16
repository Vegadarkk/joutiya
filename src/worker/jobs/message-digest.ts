import type { Locale } from "@/config/site";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { MESSAGING_KEYS, readUnreadTotal, unreadSummary } from "@/lib/messaging";
import { headroom, isDegraded } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Every 10 minutes (design D21): the grouped new-messages mail. A send that takes a recipient's
// unread total from 0 to 1 queues the account in the sorted set `msg:digest` (score = due time,
// now + 30 min, ZADD NX in scheduleDigest, src/lib/messaging/unread.ts). This job reads the due
// entries, oldest first, and for each account:
// - drops it when it read everything meanwhile, was active in the last 30 minutes (`msg:seen:{uid}`,
//   set by the badge and the inbox), turned the mail off (`private.notifications.messagesEmail ===
//   false`), has no address any more (closed, banned, missing), or waited more than a day (a
//   quota stop that long: the news is stale);
// - puts it back until the end of the 6-hour guard when a digest went out less than 6 hours ago
//   (`msg:digest:last:{uid}`), so it gets one more mail then if messages are still unread;
// - else sends one `newMessages` mail (bulk priority: the first dropped under the Resend quota),
//   with the unread count and up to 3 conversations, never the text of a message.
// Budget: at most DIGEST_MAX_MAILS a run, and digests stop at DIGEST_RESEND_SHARE of the day's and
// the month's Resend quota (transactional mails keep the rest); a stopped run leaves the entries
// for the next one. Without Valkey (local dev) nothing is queued, so nothing is sent.

export const DIGEST_GUARD_SECONDS = 6 * 3_600;
/** A due entry older than this is dropped unsent. */
export const DIGEST_MAX_AGE_MS = 24 * 3_600_000;
export const DIGEST_MAX_MAILS = 20;
/** Share of the Resend quotas (day and month) the digests may bring the counters to. */
export const DIGEST_RESEND_SHARE = 0.6;
/** Due entries read per run. */
export const DIGEST_SCAN = 100;
export const DIGEST_ITEMS = 3;

const STOP_QUOTAS = ["resend.daily", "resend.monthly", "firestore.reads"] as const;
const UID = /^[^/\s]{1,128}$/;

/** The valkey-queue commands this job uses (ioredis signatures). */
export interface DigestValkey {
  zrangebyscore(key: string, min: number | string, max: number | string, withscores: "WITHSCORES", limit: "LIMIT", offset: number, count: number): Promise<unknown>;
  zrem(key: string, member: string): Promise<number>;
  zadd(key: string, mode: "XX", score: number, member: string): Promise<unknown>;
  exists(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<unknown>;
  del(key: string): Promise<number>;
}

export interface DigestResult {
  /** Due entries read. */
  due: number;
  sent: number;
  /** Dropped: active in the last 30 minutes. */
  active: number;
  /** Dropped: nothing unread any more. */
  read: number;
  /** Dropped: mails turned off in the account settings. */
  optedOut: number;
  /** Dropped: no address (closed, banned or missing account) or a malformed entry. */
  noRecipient: number;
  /** Dropped: due for more than DIGEST_MAX_AGE_MS. */
  stale: number;
  /** Put back until the 6-hour guard ends. */
  rescheduled: number;
  failed: number;
  stopped?: "quota" | "budget" | "valkey";
}

interface DueEntry {
  uid: string;
  dueAt: number;
}

/** WITHSCORES reply (RESP2: member, score, member, score...) -> entries. */
export function parseDue(reply: unknown): DueEntry[] {
  if (!Array.isArray(reply)) return [];
  const out: DueEntry[] = [];
  for (let index = 0; index + 1 < reply.length; index += 2) {
    const uid = String(reply[index]);
    const dueAt = Number(reply[index + 1]);
    if (Number.isFinite(dueAt)) out.push({ uid, dueAt });
  }
  return out;
}

/** Mails this run may send: the per-run cap, and what is left under DIGEST_RESEND_SHARE of both quotas. */
export async function digestBudget(): Promise<number> {
  const [daily, monthly] = await Promise.all([headroom("resend.daily", DIGEST_RESEND_SHARE), headroom("resend.monthly", DIGEST_RESEND_SHARE)]);
  return Math.min(DIGEST_MAX_MAILS, daily ?? DIGEST_MAX_MAILS, monthly ?? DIGEST_MAX_MAILS);
}

interface Recipient {
  email: string;
  locale: Locale;
  displayName: string;
  messagesEmail: boolean;
}

async function recipientOf(uid: string): Promise<Recipient | null> {
  const [user, account] = await Promise.all([getUserRecord(uid), getUserPrivate(uid)]);
  if (!user || !account?.email || user.status === "closed" || user.status === "banned") return null;
  return { email: account.email, locale: user.locale, displayName: user.displayName, messagesEmail: account.notifications?.messagesEmail !== false };
}

type Outcome = "sent" | "active" | "read" | "optedOut" | "noRecipient" | "stale" | "rescheduled" | "failed";

async function serve(redis: DigestValkey, entry: DueEntry, now: Date): Promise<Outcome> {
  const { uid } = entry;
  const drop = async (outcome: Outcome): Promise<Outcome> => {
    await redis.zrem(MESSAGING_KEYS.digest, uid);
    return outcome;
  };
  if (!UID.test(uid)) return drop("noRecipient");
  if (now.getTime() - entry.dueAt > DIGEST_MAX_AGE_MS) return drop("stale");
  if ((await redis.exists(MESSAGING_KEYS.seen(uid))) === 1) return drop("active");
  const guardMs = await redis.pttl(MESSAGING_KEYS.digestLast(uid));
  if (guardMs > 0) {
    await redis.zadd(MESSAGING_KEYS.digest, "XX", now.getTime() + guardMs, uid);
    return "rescheduled";
  }
  if ((await readUnreadTotal(uid)) <= 0) return drop("read");
  const to = await recipientOf(uid);
  if (!to) return drop("noRecipient");
  if (!to.messagesEmail) return drop("optedOut");
  const summary = await unreadSummary(uid, { items: DIGEST_ITEMS });
  if (summary.total <= 0) return drop("read");
  // The guard first (NX): a mail is never sent twice for the same window, even if this run races another.
  if ((await redis.set(MESSAGING_KEYS.digestLast(uid), "1", "EX", DIGEST_GUARD_SECONDS, "NX")) !== "OK") {
    await redis.zadd(MESSAGING_KEYS.digest, "XX", now.getTime() + DIGEST_GUARD_SECONDS * 1_000, uid);
    return "rescheduled";
  }
  try {
    await sendMail({
      template: "newMessages",
      locale: to.locale,
      to: to.email,
      data: {
        displayName: to.displayName,
        count: summary.total,
        conversations: summary.items.slice(0, DIGEST_ITEMS).map((item) => ({ listingTitle: item.listingTitle, counterpartName: item.counterpartName })),
      },
      priority: "bulk",
      idempotencyKey: `newMessages-${uid}-${entry.dueAt}`,
    });
  } catch (error) {
    // Not queued: the guard goes, the entry stays for the next run.
    await redis.del(MESSAGING_KEYS.digestLast(uid)).catch(() => 0);
    logger.warn({ err: (error as Error).message }, "message digest not queued");
    return "failed";
  }
  return drop("sent");
}

export async function sendMessageDigests(now = new Date(), deps: { valkey?: DigestValkey | null } = {}): Promise<DigestResult> {
  const result: DigestResult = { due: 0, sent: 0, active: 0, read: 0, optedOut: 0, noRecipient: 0, stale: 0, rescheduled: 0, failed: 0 };
  const redis = "valkey" in deps ? deps.valkey : isValkeyConfigured("queue") ? (valkey("queue") as unknown as DigestValkey) : null;
  if (!redis) {
    logger.info("message-digest skipped: Valkey not configured (no digest is ever queued)");
    return result;
  }
  if (!isFirestoreConfigured()) {
    logger.warn("message-digest skipped: Firebase not configured");
    return result;
  }
  for (const id of STOP_QUOTAS) {
    if (!(await isDegraded(id))) continue;
    logger.info({ quota: id }, "message-digest skipped: quota degraded");
    return { ...result, stopped: "quota" };
  }
  let budget = await digestBudget();
  if (budget <= 0) {
    logger.info("message-digest skipped: Resend share of the digests used");
    return { ...result, stopped: "budget" };
  }
  let due: DueEntry[];
  try {
    due = parseDue(await redis.zrangebyscore(MESSAGING_KEYS.digest, "-inf", now.getTime(), "WITHSCORES", "LIMIT", 0, DIGEST_SCAN));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "message-digest: Valkey unavailable");
    return { ...result, stopped: "valkey" };
  }
  for (const entry of due) {
    if (budget <= 0) {
      result.stopped = "budget";
      break;
    }
    result.due += 1;
    let outcome: Outcome;
    try {
      outcome = await serve(redis, entry, now);
    } catch (error) {
      // Valkey or Firestore failing for this account: it stays queued, the next run retries.
      logger.warn({ err: (error as Error).message }, "message digest failed");
      outcome = "failed";
    }
    result[outcome] += 1;
    if (outcome === "sent") budget -= 1;
  }
  logger.info({ ...result }, "message-digest");
  return result;
}
