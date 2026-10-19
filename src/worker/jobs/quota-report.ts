import { alert } from "@/lib/alert";
import { writeQuotaDaily } from "@/lib/db/repositories/quota-daily";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { readQuotas } from "@/lib/quota";

/**
 * Nightly snapshot of the free-quota counters (§5 `quotaDaily/{date}`): the day that just ended
 * (UTC), with the share reached. Monthly counters show the month to date.
 */
export async function quotaReport(): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 3_600_000);
  const date = yesterday.toISOString().slice(0, 10);
  const quotas = await readQuotas(yesterday);
  const snapshot = Object.fromEntries(
    quotas.map((quota) => [quota.id, { period: quota.period, used: quota.used, limit: quota.limit, ratio: Number(quota.ratio.toFixed(4)), level: quota.level }]),
  );
  if (isFirestoreConfigured()) await writeQuotaDaily({ date, quotas: snapshot, createdAt: new Date() });
  const unknown = quotas.filter((quota) => quota.level === "unknown");
  if (unknown.length > 0) {
    await alert({ severity: "P1", title: "Compteurs de quotas illisibles", body: `Valkey (file) ne répond pas : ${unknown.length} compteurs inconnus pour le ${date}.` });
  }
  logger.info({ date, warnings: quotas.filter((quota) => quota.level !== "ok").map((quota) => quota.id) }, "quota report");
}
