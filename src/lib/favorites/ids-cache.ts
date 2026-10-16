import "server-only";
import type { Redis } from "ioredis";
import { logger } from "@/lib/logging/logger";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Hearts cache (design D17): the favorite listing ids of an account as a Valkey set `fav:{uid}` on
// valkey-queue (noeviction), 30 days, rebuilt from the subcollection on a miss. GET
// /api/favorites/ids then costs no Firestore read. A sentinel member marks a complete set (an empty
// favorites list is cached too; a set without it is a miss). Writes bump a version key, and a
// rebuild only stores what it read when no write happened meanwhile (Lua, atomic). Valkey is a
// cache here: unconfigured or failing, the subcollection answers.
// `stats:favorites:{listingId}` counts adds minus removes since the last stats flush (later phase).

export const FAVORITE_IDS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Not a listing id ([a-hj-km-np-z2-9]{8}): marks a complete set. */
export const FAVORITE_IDS_SENTINEL = "~";
/** Request path: a slow Valkey falls back to Firestore instead of holding the request. */
const VALKEY_TIMEOUT_MS = 800;

export const favoriteIdsKey = (uid: string) => `fav:${uid}`;
export const favoriteIdsVersionKey = (uid: string) => `fav:${uid}:v`;
export const favoriteStatKey = (listingId: string) => `stats:favorites:${listingId}`;

/** KEYS: set, version. ARGV: expected version, ttl ms, sentinel, ids... */
export const REBUILD_SCRIPT = `if (redis.call("GET", KEYS[2]) or "0") ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
redis.call("SADD", KEYS[1], unpack(ARGV, 3))
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1`;

/** KEYS: set, version. ARGV: "add" | "remove", listing id, ttl ms, sentinel. */
export const WRITE_SCRIPT = `redis.call("INCR", KEYS[2])
redis.call("PEXPIRE", KEYS[2], ARGV[3])
if redis.call("SISMEMBER", KEYS[1], ARGV[4]) == 1 then
  if ARGV[1] == "add" then redis.call("SADD", KEYS[1], ARGV[2]) else redis.call("SREM", KEYS[1], ARGV[2]) end
  redis.call("PEXPIRE", KEYS[1], ARGV[3])
end
return 1`;

type Client = Pick<Redis, "smembers" | "get" | "eval" | "incrby">;

let clientForTests: Client | null | undefined;

/** Tests: a fake client (null = behave as unconfigured); undefined restores the real one. */
export function setFavoriteCacheClientForTests(client: Client | null | undefined): void {
  clientForTests = client;
}

function client(): Client | null {
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

/** The favorite ids of `uid`: the cached set, else `load()` (the subcollection), cached for next time. */
export async function cachedFavoriteIds(uid: string, load: () => Promise<string[]>): Promise<string[]> {
  const redis = client();
  if (!redis) return load();
  let version: string;
  try {
    const members = await timed(redis.smembers(favoriteIdsKey(uid)));
    if (members.includes(FAVORITE_IDS_SENTINEL)) return members.filter((member) => member !== FAVORITE_IDS_SENTINEL);
    version = (await timed(redis.get(favoriteIdsVersionKey(uid)))) ?? "0";
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "favorites cache unavailable");
    return load();
  }
  const ids = await load();
  try {
    await timed(redis.eval(REBUILD_SCRIPT, 2, favoriteIdsKey(uid), favoriteIdsVersionKey(uid), version, FAVORITE_IDS_TTL_MS, FAVORITE_IDS_SENTINEL, ...ids));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "favorites cache rebuild failed");
  }
  return ids;
}

/** After a committed add or remove: the set follows (when cached) and a racing rebuild is voided. Best effort. */
export async function recordFavoriteChange(uid: string, listingId: string, change: "add" | "remove"): Promise<void> {
  const redis = client();
  if (!redis) return;
  try {
    await timed(redis.eval(WRITE_SCRIPT, 2, favoriteIdsKey(uid), favoriteIdsVersionKey(uid), change, listingId, FAVORITE_IDS_TTL_MS, FAVORITE_IDS_SENTINEL));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "favorites cache write failed");
  }
}

/** +1 / -1 on the listing's favorites counter (flushed to listingStats by a later phase). Best effort. */
export async function bumpFavoriteStat(listingId: string, delta: 1 | -1): Promise<void> {
  const redis = client();
  if (!redis) return;
  try {
    await timed(redis.incrby(favoriteStatKey(listingId), delta));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "favorites counter failed");
  }
}
