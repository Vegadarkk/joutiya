import "server-only";
import { DEFAULT_AI, resolveAiConfig, type AiConfig } from "@/config/ai";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";

// Firestore `config/ai` over the defaults, cached 5 minutes in memory, for the report thresholds
// (D11: `reports.autoHideNsfwAt`, `trustedFlaggers`). Same pattern as src/lib/legal/config.ts.
// TODO(integration): use the shared config/ai loader once src/lib/ai (L4) exports one.

const TTL_MS = 5 * 60 * 1000;
let cache: { value: AiConfig; expires: number } | undefined;

/** Never throws: the last known value, then the defaults. */
export async function reportsAiConfig(): Promise<AiConfig> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  if (!isFirestoreConfigured()) return DEFAULT_AI;
  try {
    const snapshot = await db().collection("config").doc("ai").get();
    void consume("firestore.reads", 1);
    const { config, errors } = resolveAiConfig(snapshot.exists ? snapshot.data() : undefined);
    if (errors.length > 0) logger.error({ errors }, "config/ai is invalid: defaults apply to reports");
    cache = { value: config, expires: now + TTL_MS };
    return config;
  } catch (error) {
    logger.error({ err: (error as Error).message }, "config/ai unreachable: last known value applies to reports");
    return cache?.value ?? DEFAULT_AI;
  }
}

/** Tests: forget the cached value. */
export function resetReportsAiConfig(): void {
  cache = undefined;
}
