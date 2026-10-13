import "server-only";
import { Redis, type RedisOptions } from "ioredis";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";

// Two Valkey instances (§2): valkey-queue (noeviction, AOF) for BullMQ jobs and quota counters,
// valkey-ratelimit (allkeys-lru, no persistence) for rate limiting. Separate instances, so an
// attack that fills the limiter keys can never evict a payment or outbox job.

export type ValkeyRole = "queue" | "ratelimit";

const clients = new Map<ValkeyRole, Redis>();

function url(role: ValkeyRole): string | undefined {
  const env = serverEnv();
  return role === "queue" ? env.QUEUE_REDIS_URL : env.RATE_LIMIT_REDIS_URL;
}

export function isValkeyConfigured(role: ValkeyRole): boolean {
  return Boolean(url(role));
}

/** Options shared by app clients; BullMQ workers need maxRetriesPerRequest: null instead. */
export function clientOptions(role: ValkeyRole, overrides: RedisOptions = {}): RedisOptions {
  return {
    connectionName: `joutiya-${role}`,
    lazyConnect: true,
    // Fail fast in request paths: limiter policies decide fail-open or fail-closed (§6).
    maxRetriesPerRequest: role === "ratelimit" ? 1 : 3,
    connectTimeout: 2_000,
    enableOfflineQueue: role === "queue",
    ...overrides,
  };
}

export function valkey(role: ValkeyRole): Redis {
  const existing = clients.get(role);
  if (existing) return existing;
  const target = url(role);
  if (!target) throw new Error(`Valkey ${role} is not configured`);
  const client = new Redis(target, clientOptions(role));
  client.on("error", (error: Error) => logger.warn({ role, err: error.message }, "valkey connection error"));
  clients.set(role, client);
  return client;
}

/** Round-trip check used by /api/health; never throws. */
export async function pingValkey(role: ValkeyRole, timeoutMs = 1_000): Promise<boolean> {
  if (!isValkeyConfigured(role)) return false;
  try {
    const result = await Promise.race([
      valkey(role).ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return result === "PONG";
  } catch {
    return false;
  }
}

export async function closeValkey(): Promise<void> {
  await Promise.allSettled([...clients.values()].map((client) => client.quit()));
  clients.clear();
}
