import "server-only";
import { serverEnv } from "@/lib/env";
import { isMeiliConfigured, searchEngine } from "@/lib/search/engine";
import { SEARCH_LAG_KEY } from "@/lib/search/indexer";
import { isValkeyConfigured, pingValkey, valkey } from "@/lib/valkey/clients";

/** Key refreshed by the worker; stale after WORKER_HEARTBEAT_TTL seconds. */
export const WORKER_HEARTBEAT_KEY = "health:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL = 90;

export type CheckState = "ok" | "fail" | "skipped";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<"valkeyQueue" | "valkeyRateLimit" | "worker", CheckState>;
  /**
   * Informational, never part of `status` (design D2): search down means /api/search 503 and an
   * error state on /recherche, not a site outage. `searchLagSeconds`: age of the oldest search
   * outbox entry as last measured by the worker's poll (null when unknown).
   */
  info: { meilisearch: CheckState; searchLagSeconds: number | null };
  release: string;
}

const TIMEOUT_MS = 1_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))]);
}

async function workerAlive(): Promise<CheckState> {
  if (!isValkeyConfigured("queue")) return "skipped";
  try {
    return (await valkey("queue").exists(WORKER_HEARTBEAT_KEY)) === 1 ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

/** Skipped in dev on the in-memory engine; elsewhere a missing MEILI_URL is a failure. */
async function meilisearch(): Promise<CheckState> {
  try {
    if (!isMeiliConfigured() && serverEnv().APP_ENV === "dev") return "skipped";
    return (await withTimeout(searchEngine().healthy())) ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

async function searchLagSeconds(): Promise<number | null> {
  if (!isValkeyConfigured("queue")) return null;
  try {
    const value = await withTimeout(valkey("queue").get(SEARCH_LAG_KEY));
    const seconds = value === null ? Number.NaN : Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
  } catch {
    return null;
  }
}

const state = async (configured: boolean, check: () => Promise<boolean>): Promise<CheckState> =>
  configured ? ((await check()) ? "ok" : "fail") : "skipped";

export async function healthReport(): Promise<HealthReport> {
  const [valkeyQueue, valkeyRateLimit, worker, search, lag] = await Promise.all([
    state(isValkeyConfigured("queue"), () => pingValkey("queue")),
    state(isValkeyConfigured("ratelimit"), () => pingValkey("ratelimit")),
    workerAlive(),
    meilisearch(),
    searchLagSeconds(),
  ]);
  const checks = { valkeyQueue, valkeyRateLimit, worker };
  return {
    status: Object.values(checks).includes("fail") ? "degraded" : "ok",
    checks,
    info: { meilisearch: search, searchLagSeconds: lag },
    release: process.env.RELEASE ?? "dev",
  };
}
