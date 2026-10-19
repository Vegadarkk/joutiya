import "server-only";
import type { Redis } from "ioredis";
import { logger } from "@/lib/logging/logger";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Messaging state kept in valkey-queue (noeviction), design D3, D5, D21:
// - unread badge outside /messages: hash `msg:unread:{uid}` field cid -> count. The source of truth
//   stays `conversation.unread[uid]`; the hash is trusted only while `msg:unread:init:{uid}` exists
//   (set by a rebuild from the 50 newest conversations, 30 days, refreshed by every new message).
//   Every change bumps `msg:unread:v:{uid}`, and a rebuild stores what it read only when no change
//   happened meanwhile (Lua, atomic), the favorites cache pattern;
// - `msg:seen:{uid}` (30 min): the account looked at its badge or inbox recently (digest skip);
// - `msg:digest` sorted set, score = due time in epoch ms, member uid: the grouped new-messages
//   mail (job message-digest, lot L5; `msg:digest:last:{uid}` is that job's 6-hour guard);
// - `msg:risk:{uid}` sorted set of `{cid}/{mid}` flagged in the last 24 h, and the once-a-day
//   `msg:risk:reported:{uid}` marker of the repeat rule (system report).
// Unconfigured (dev without Valkey, unit tests): counts come from Firestore, nothing is cached.

const DAY_MS = 24 * 60 * 60 * 1000;
export const UNREAD_TTL_MS = 30 * DAY_MS;
export const SEEN_TTL_SECONDS = 30 * 60;
export const DIGEST_DELAY_MS = 30 * 60 * 1000;
export const RISK_WINDOW_MS = DAY_MS;
/** Repeat rule (D5): flagged messages in 24 h, across at least this many conversations. */
export const RISK_REPEAT_MESSAGES = 3;
export const RISK_REPEAT_CONVERSATIONS = 2;
/** Request path: a slow Valkey must not hold a message send. */
const VALKEY_TIMEOUT_MS = 800;

export const MESSAGING_KEYS = {
  unread: (uid: string) => `msg:unread:${uid}`,
  unreadInit: (uid: string) => `msg:unread:init:${uid}`,
  unreadVersion: (uid: string) => `msg:unread:v:${uid}`,
  seen: (uid: string) => `msg:seen:${uid}`,
  /** Sorted set: score = due time (epoch ms), member = uid. */
  digest: "msg:digest",
  digestLast: (uid: string) => `msg:digest:last:${uid}`,
  risk: (uid: string) => `msg:risk:${uid}`,
  riskReported: (uid: string) => `msg:risk:reported:${uid}`,
} as const;

/** KEYS: hash, init marker, version. ARGV: expected version, ttl ms, cid1, count1, cid2, count2... */
export const REBUILD_SCRIPT = `if (redis.call("GET", KEYS[3]) or "0") ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
if #ARGV > 2 then
  redis.call("HSET", KEYS[1], unpack(ARGV, 3))
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
redis.call("SET", KEYS[2], "1", "PX", ARGV[2])
return 1`;

export type MessagingValkey = Pick<Redis, "multi" | "eval" | "set" | "zadd">;

let clientForTests: MessagingValkey | null | undefined;

/** Tests: a fake client (null = behave as unconfigured); undefined restores the real one. */
export function setMessagingValkeyForTests(client: MessagingValkey | null | undefined): void {
  clientForTests = client;
}

function client(): MessagingValkey | null {
  if (clientForTests !== undefined) return clientForTests;
  return isValkeyConfigured("queue") ? valkey("queue") : null;
}

function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("valkey timeout")), VALKEY_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type ExecResult = [Error | null, unknown][] | null;

/** Results of a MULTI, or an error when the transaction or one of its commands failed. */
function results(exec: ExecResult): unknown[] {
  if (!exec) throw new Error("valkey transaction aborted");
  return exec.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

function sum(values: Iterable<unknown>): number {
  let total = 0;
  for (const value of values) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

export class UnreadUnavailableError extends Error {
  constructor(cause: unknown) {
    super("unread counters unavailable", { cause });
    this.name = "UnreadUnavailableError";
  }
}

/**
 * After a committed message: +1 for `uid` on `cid`. Returns the account's new total when the hash
 * is trusted (init marker present), null otherwise or when Valkey fails. Best effort.
 */
export async function recordUnread(uid: string, cid: string): Promise<number | null> {
  const redis = client();
  if (!redis) return null;
  try {
    const [, , exists, , , , values] = results(
      await timed(
        redis
          .multi()
          .incr(MESSAGING_KEYS.unreadVersion(uid))
          .pexpire(MESSAGING_KEYS.unreadVersion(uid), UNREAD_TTL_MS)
          .exists(MESSAGING_KEYS.unreadInit(uid))
          .hincrby(MESSAGING_KEYS.unread(uid), cid, 1)
          .pexpire(MESSAGING_KEYS.unread(uid), UNREAD_TTL_MS)
          .pexpire(MESSAGING_KEYS.unreadInit(uid), UNREAD_TTL_MS)
          .hvals(MESSAGING_KEYS.unread(uid))
          .exec(),
      ),
    );
    return Number(exists) === 1 ? sum(values as unknown[]) : null;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging unread counter failed");
    return null;
  }
}

/**
 * The account read (or hid) `cid`: its count leaves the badge. Returns the account's new total when
 * the hash is trusted (init marker present), null otherwise or when Valkey fails. Best effort.
 */
export async function clearUnread(uid: string, cid: string): Promise<number | null> {
  const redis = client();
  if (!redis) return null;
  try {
    const [, , , exists, values] = results(
      await timed(
        redis
          .multi()
          .incr(MESSAGING_KEYS.unreadVersion(uid))
          .pexpire(MESSAGING_KEYS.unreadVersion(uid), UNREAD_TTL_MS)
          .hdel(MESSAGING_KEYS.unread(uid), cid)
          .exists(MESSAGING_KEYS.unreadInit(uid))
          .hvals(MESSAGING_KEYS.unread(uid))
          .exec(),
      ),
    );
    return Number(exists) === 1 ? sum(values as unknown[]) : null;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging unread clear failed");
    return null;
  }
}

/** cid -> unread count of an account, from Firestore (the 50 newest conversations). */
export type UnreadLoader = () => Promise<Record<string, number>>;

/**
 * Unread total of `uid`: the Valkey hash while trusted, else rebuilt from `load()` and cached.
 * Unconfigured: `load()` every time. Valkey failing: UnreadUnavailableError (the route answers 503
 * rather than reading 50 documents on every badge refresh).
 */
export async function unreadTotal(uid: string, load: UnreadLoader): Promise<number> {
  const redis = client();
  if (!redis) return sum(Object.values(await load()));
  let version: string;
  try {
    const [exists, values, current] = results(
      await timed(redis.multi().exists(MESSAGING_KEYS.unreadInit(uid)).hvals(MESSAGING_KEYS.unread(uid)).get(MESSAGING_KEYS.unreadVersion(uid)).exec()),
    );
    if (Number(exists) === 1) return sum(values as unknown[]);
    version = typeof current === "string" ? current : "0";
  } catch (error) {
    throw new UnreadUnavailableError(error);
  }
  const counts = await load();
  const pairs = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .flatMap(([cid, count]) => [cid, String(count)]);
  try {
    await timed(
      redis.eval(REBUILD_SCRIPT, 3, MESSAGING_KEYS.unread(uid), MESSAGING_KEYS.unreadInit(uid), MESSAGING_KEYS.unreadVersion(uid), version, String(UNREAD_TTL_MS), ...pairs),
    );
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging unread rebuild failed");
  }
  return sum(Object.values(counts));
}

/** The account looked at its messages: no digest mail for the next 30 minutes. Best effort. */
export async function markSeen(uid: string): Promise<void> {
  const redis = client();
  if (!redis) return;
  try {
    await timed(redis.set(MESSAGING_KEYS.seen(uid), "1", "EX", SEEN_TTL_SECONDS));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging seen marker failed");
  }
}

/**
 * Queues the grouped new-messages mail of `uid` (D21): due 30 minutes from now, NX so the first
 * unread message fixes the time. True when queued now. Best effort (no mail without Valkey).
 */
export async function scheduleDigest(uid: string, now = new Date()): Promise<boolean> {
  const redis = client();
  if (!redis) return false;
  try {
    const added = await timed(redis.zadd(MESSAGING_KEYS.digest, "NX", now.getTime() + DIGEST_DELAY_MS, uid));
    return Number(added) === 1;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging digest scheduling failed");
    return false;
  }
}

/**
 * Records a flagged message of `uid` (`ref` = "{cid}/{mid}") and applies the repeat rule (D5): at
 * least 3 flagged messages in 24 hours across at least 2 conversations, once per 24 hours (NX).
 * True when the caller must file the system report now. Valkey down: false (no report).
 */
export async function recordRiskyMessage(uid: string, ref: string, now = new Date()): Promise<boolean> {
  const redis = client();
  if (!redis) return false;
  const at = now.getTime();
  try {
    const [, , , members] = results(
      await timed(
        redis
          .multi()
          .zadd(MESSAGING_KEYS.risk(uid), at, ref)
          .zremrangebyscore(MESSAGING_KEYS.risk(uid), "-inf", at - RISK_WINDOW_MS)
          .pexpire(MESSAGING_KEYS.risk(uid), RISK_WINDOW_MS)
          .zrange(MESSAGING_KEYS.risk(uid), 0, "-1")
          .exec(),
      ),
    );
    const refs = (members as string[]) ?? [];
    const conversations = new Set(refs.map((member) => member.split("/", 1)[0]));
    if (refs.length < RISK_REPEAT_MESSAGES || conversations.size < RISK_REPEAT_CONVERSATIONS) return false;
    const first = await timed(redis.set(MESSAGING_KEYS.riskReported(uid), "1", "PX", RISK_WINDOW_MS, "NX"));
    return first === "OK";
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "messaging risk counter failed");
    return false;
  }
}
