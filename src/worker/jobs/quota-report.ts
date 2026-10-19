import { QUOTAS } from "@/config/quotas";
import { alert } from "@/lib/alert";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume, readQuotas } from "@/lib/quota";

/**
 * Nightly snapshot of the free-quota counters (§5 `quotaDaily/{date}`): the day that just ended
 * (UTC), with the share reached. Monthly counters show the month to date. A gauge not measured in
 * its period (no R2, no complete backup cycle yet) shows "unknown": only unknown counters mean
 * Valkey did not answer.
 */
export async function quotaReport(): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 3_600_000);
  const date = yesterday.toISOString().slice(0, 10);
  const quotas = await readQuotas(yesterday);
  const snapshot = Object.fromEntries(
    quotas.map((quota) => [quota.id, { period: quota.period, used: quota.used, limit: quota.limit, ratio: Number(quota.ratio.toFixed(4)), level: quota.level }]),
  );
  if (isFirestoreConfigured()) {
    await db().collection("quotaDaily").doc(date).set({ date, quotas: snapshot, createdAt: new Date() }, { merge: true });
    void consume("firestore.writes", 1);
  }
  const unknown = quotas.filter((quota) => quota.level === "unknown" && QUOTAS[quota.id].kind === "counter");
  if (unknown.length > 0) {
    await alert({ severity: "P1", title: "Compteurs de quotas illisibles", body: `Valkey (file) ne répond pas : ${unknown.length} compteurs inconnus pour le ${date}.` });
  }
  logger.info({ date, warnings: quotas.filter((quota) => quota.level !== "ok").map((quota) => quota.id) }, "quota report");
}
