import { sumReadyBytes } from "@/lib/db/repositories/uploads";
import { serverEnv } from "@/lib/env";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import type { QuotaStatus } from "@/lib/quota";
import { readMediaBytes, resetMediaBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:10 UTC (D15): recount of the media bucket from the `ready` uploads (one Firestore
// aggregation), which replaces the running Valkey counter, then the r2.storage gauge = that sum +
// R2_STORAGE_BASELINE_BYTES. setGauge alerts once per level (8 GB warning, 9.5 GB degraded: new
// uploads refused with storage_full).

export interface R2StorageGaugeResult {
  mediaBytes: number;
  baselineBytes: number;
  totalBytes: number;
  /** Counter value replaced by the recount (null when unknown): the day's accounting drift. */
  counterBefore: number | null;
  level: QuotaStatus["level"];
}

export async function r2StorageGauge(now = new Date()): Promise<R2StorageGaugeResult | null> {
  if (!isFirestoreConfigured()) {
    logger.warn("r2-storage-gauge skipped: Firebase not configured");
    return null;
  }
  const mediaBytes = await sumReadyBytes();
  const baselineBytes = serverEnv().R2_STORAGE_BASELINE_BYTES;
  const counterBefore = await readMediaBytes();
  const status = await resetMediaBytes(mediaBytes, now);
  const result: R2StorageGaugeResult = { mediaBytes, baselineBytes, totalBytes: mediaBytes + baselineBytes, counterBefore, level: status?.level ?? "unknown" };
  logger.info({ ...result }, "r2-storage-gauge");
  return result;
}
