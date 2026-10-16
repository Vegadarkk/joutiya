import "server-only";
import { DEFAULT_AI, resolveAiConfig, type AiConfig } from "@/config/ai";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";

// Firestore `config/ai` over the defaults (src/config/ai.ts), cached 5 minutes in memory: models,
// prices, D20 thresholds, fallback settings. The shared loader of config/ai (the reports lot keeps
// its own copy until integration).

const TTL_MS = 5 * 60 * 1000;
let cache: { value: AiConfig; expires: number } | undefined;

/** Never throws: the last known value, then the defaults. */
export async function aiConfig(): Promise<AiConfig> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  if (!isFirestoreConfigured()) return DEFAULT_AI;
  try {
    const snapshot = await db().collection("config").doc("ai").get();
    void consume("firestore.reads", 1);
    const { config, errors } = resolveAiConfig(snapshot.exists ? snapshot.data() : undefined);
    if (errors.length > 0) logger.error({ errors }, "config/ai is invalid: defaults apply to the agent");
    cache = { value: config, expires: now + TTL_MS };
    return config;
  } catch (error) {
    logger.error({ err: (error as Error).message }, "config/ai unreachable: last known value applies to the agent");
    return cache?.value ?? DEFAULT_AI;
  }
}

/** Tests: forget the cached value (or pin one). */
export function setAiConfigForTests(value: AiConfig | undefined): void {
  cache = value ? { value, expires: Number.MAX_SAFE_INTEGER } : undefined;
}
