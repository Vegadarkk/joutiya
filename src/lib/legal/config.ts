import "server-only";
import { DEFAULT_LEGAL, resolveLegalConfig, type LegalConfig } from "@/config/legal";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";

// Firestore `config/legal` over the defaults, cached 5 minutes in memory (§5, §7). The cache lives
// on globalThis: route handlers and server components load separate copies of this module, and a
// back-office save (route handler) must drop the copy the pages read.
const TTL_MS = 5 * 60 * 1000;
const STATE_KEY = Symbol.for("joutiya.legal.configCache");
interface CacheState {
  cache?: { value: LegalConfig; expires: number };
  /** Bumped by invalidateLegalConfig: a read started before a save does not cache the old value. */
  generation: number;
}
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: CacheState };

function state(): CacheState {
  const store = globalThis as GlobalWithState;
  return (store[STATE_KEY] ??= { generation: 0 });
}

/** Reads `config/legal` (throws when Firestore is unreachable). */
export async function fetchLegalConfig(): Promise<{ config: LegalConfig; errors: string[] }> {
  if (!isFirestoreConfigured()) return { config: DEFAULT_LEGAL, errors: [] };
  const snapshot = await db().collection("config").doc("legal").get();
  void consume("firestore.reads", 1);
  return resolveLegalConfig(snapshot.exists ? snapshot.data() : undefined);
}

/** Legal config for rendering: never throws; falls back to the last value, then the defaults. */
export async function getLegalConfig(): Promise<LegalConfig> {
  const now = Date.now();
  const shared = state();
  if (shared.cache && shared.cache.expires > now) return shared.cache.value;
  const started = shared.generation;
  try {
    const { config, errors } = await fetchLegalConfig();
    if (errors.length > 0) logger.error({ errors }, "config/legal is invalid: defaults rendered");
    if (started === shared.generation) shared.cache = { value: config, expires: now + TTL_MS };
    return config;
  } catch (error) {
    logger.error({ err: error }, "config/legal unreachable: last known value rendered");
    return shared.cache?.value ?? DEFAULT_LEGAL;
  }
}

/** Drops the cached value: the next render reads `config/legal` again (after a back-office save). */
export function invalidateLegalConfig(): void {
  const shared = state();
  shared.cache = undefined;
  shared.generation += 1;
}
