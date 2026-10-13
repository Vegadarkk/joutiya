import "server-only";
import { QUOTA_IDS, QUOTAS, type QuotaId } from "@/config/quotas";
import { alert } from "@/lib/alert";
import { logger } from "@/lib/logging/logger";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { classify, periodKey, retentionSeconds, type QuotaLevel } from "./period";

// Counters live in valkey-queue (noeviction, AOF): they must survive a restart and never be
// evicted by rate-limit pressure (§2).

export interface QuotaStatus {
  id: QuotaId;
  period: string;
  used: number;
  limit: number;
  ratio: number;
  level: QuotaLevel | "unknown";
}

function counterKey(id: QuotaId, period: string): string {
  return `quota:${id}:${period}`;
}

function status(id: QuotaId, period: string, used: number | null): QuotaStatus {
  const definition = QUOTAS[id];
  if (used === null) return { id, period, used: 0, limit: definition.limit, ratio: 0, level: "unknown" };
  return { id, period, used, limit: definition.limit, ratio: used / definition.limit, level: classify(definition, used) };
}

const LEVEL_TITLE: Record<Exclude<QuotaLevel, "ok">, string> = {
  warning: "Quota gratuit à {pct} %",
  degraded: "Quota gratuit épuisé : mode dégradé",
};

/** Alerts once per level and period (SET NX), never twice for the same crossing. */
async function notifyCrossing(current: QuotaStatus): Promise<void> {
  if (current.level !== "warning" && current.level !== "degraded") return;
  const definition = QUOTAS[current.id];
  const marker = `quota:alerted:${current.id}:${current.period}:${current.level}`;
  const first = await valkey("queue").set(marker, "1", "EX", retentionSeconds(definition), "NX");
  if (first !== "OK") return;
  const pct = Math.floor(current.ratio * 100);
  await alert({
    severity: current.level === "degraded" ? "P1" : "P2",
    title: `${LEVEL_TITLE[current.level].replace("{pct}", String(pct))} : ${definition.service} (${current.id})`,
    body: `${current.used} / ${definition.limit} ${definition.unit} pour ${current.period}.\nMode dégradé : ${definition.degradedMode}`,
  });
}

/**
 * Records usage of a counter quota. Never throws: an unavailable Valkey must not break the
 * feature that consumed the quota (the level is then "unknown", and callers decide).
 */
export async function consume(id: QuotaId, amount = 1, at = new Date()): Promise<QuotaStatus> {
  const definition = QUOTAS[id];
  const period = periodKey(definition, at);
  if (!isValkeyConfigured("queue")) return status(id, period, null);
  try {
    const key = counterKey(id, period);
    const [[, used]] = (await valkey("queue")
      .multi()
      .incrby(key, Math.round(amount))
      .expire(key, retentionSeconds(definition))
      .exec()) as [[Error | null, number], [Error | null, number]];
    const current = status(id, period, used);
    await notifyCrossing(current);
    return current;
  } catch (error) {
    logger.warn({ quota: id, err: (error as Error).message }, "quota counter unavailable");
    return status(id, period, null);
  }
}

/** Records a measured value (stored bytes) for a gauge quota. Never throws. */
export async function setGauge(id: QuotaId, value: number, at = new Date()): Promise<QuotaStatus> {
  const definition = QUOTAS[id];
  const period = periodKey(definition, at);
  if (!isValkeyConfigured("queue")) return status(id, period, null);
  try {
    await valkey("queue").set(counterKey(id, period), String(Math.round(value)), "EX", retentionSeconds(definition));
    const current = status(id, period, Math.round(value));
    await notifyCrossing(current);
    return current;
  } catch (error) {
    logger.warn({ quota: id, err: (error as Error).message }, "quota gauge unavailable");
    return status(id, period, null);
  }
}

/** Current level of every quota, for degraded-mode decisions and the nightly report. */
export async function readQuotas(at = new Date()): Promise<QuotaStatus[]> {
  const periods = QUOTA_IDS.map((id) => periodKey(QUOTAS[id], at));
  if (!isValkeyConfigured("queue")) return QUOTA_IDS.map((id, index) => status(id, periods[index] ?? "", null));
  try {
    const values = await valkey("queue").mget(QUOTA_IDS.map((id, index) => counterKey(id, periods[index] ?? "")));
    return QUOTA_IDS.map((id, index) => status(id, periods[index] ?? "", values[index] ? Number(values[index]) : 0));
  } catch {
    return QUOTA_IDS.map((id, index) => status(id, periods[index] ?? "", null));
  }
}

/** True once the degraded mode of this quota applies. Unknown counts as available. */
export async function isDegraded(id: QuotaId): Promise<boolean> {
  const definition = QUOTAS[id];
  const period = periodKey(definition, new Date());
  if (!isValkeyConfigured("queue")) return false;
  try {
    const value = await valkey("queue").get(counterKey(id, period));
    return value !== null && classify(definition, Number(value)) === "degraded";
  } catch {
    return false;
  }
}
