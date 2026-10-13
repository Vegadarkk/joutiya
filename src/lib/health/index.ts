import "server-only";
import { isValkeyConfigured, pingValkey, valkey } from "@/lib/valkey/clients";

/** Key refreshed by the worker; stale after WORKER_HEARTBEAT_TTL seconds. */
export const WORKER_HEARTBEAT_KEY = "health:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL = 90;

export type CheckState = "ok" | "fail" | "skipped";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<"valkeyQueue" | "valkeyRateLimit" | "worker", CheckState>;
  release: string;
}

async function workerAlive(): Promise<CheckState> {
  if (!isValkeyConfigured("queue")) return "skipped";
  try {
    return (await valkey("queue").exists(WORKER_HEARTBEAT_KEY)) === 1 ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

const state = async (configured: boolean, check: () => Promise<boolean>): Promise<CheckState> =>
  configured ? ((await check()) ? "ok" : "fail") : "skipped";

export async function healthReport(): Promise<HealthReport> {
  const [valkeyQueue, valkeyRateLimit, worker] = await Promise.all([
    state(isValkeyConfigured("queue"), () => pingValkey("queue")),
    state(isValkeyConfigured("ratelimit"), () => pingValkey("ratelimit")),
    workerAlive(),
  ]);
  const checks = { valkeyQueue, valkeyRateLimit, worker };
  return {
    status: Object.values(checks).includes("fail") ? "degraded" : "ok",
    checks,
    release: process.env.RELEASE ?? "dev",
  };
}
