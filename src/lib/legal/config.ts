import "server-only";
import { DEFAULT_LEGAL, resolveLegalConfig, type LegalConfig } from "@/config/legal";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";

// Firestore `config/legal` over the defaults, cached 5 minutes in memory (§5, §7).
const TTL_MS = 5 * 60 * 1000;
let cache: { value: LegalConfig; expires: number } | undefined;

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
  if (cache && cache.expires > now) return cache.value;
  try {
    const { config, errors } = await fetchLegalConfig();
    if (errors.length > 0) logger.error({ errors }, "config/legal is invalid: defaults rendered");
    cache = { value: config, expires: now + TTL_MS };
    return config;
  } catch (error) {
    logger.error({ err: error }, "config/legal unreachable: last known value rendered");
    return cache?.value ?? DEFAULT_LEGAL;
  }
}
