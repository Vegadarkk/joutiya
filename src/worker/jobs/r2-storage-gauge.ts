import { readRetainedBackupBytes } from "@/lib/backup/export";
import { sumStoredBytes } from "@/lib/db/repositories/uploads";
import { serverEnv } from "@/lib/env";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import type { QuotaStatus } from "@/lib/quota";
import { MAP_TILES_RESERVE_BYTES, readBackupBytes, readMediaBytes, resetMediaBytes, setBackupBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:10 UTC (D15): recount of the photos from the uploads whose variants are stored
// (two Firestore aggregations: `ready`, and deleted under a legal hold; a removed listing's photos
// count once, from the private bucket they moved to), which
// replaces the running Valkey counter, and of the encrypted backups still in
// the private bucket (98 days, from the bytes the backup job records in system/backup: one read).
// The r2.storage gauge = media + backups + map tiles reserve + R2_STORAGE_BASELINE_BYTES. setGauge
// alerts once per level (8 GB warning, 9.5 GB degraded: new uploads refused with storage_full).

export interface R2StorageGaugeResult {
  mediaBytes: number;
  /** Encrypted backups within the retention; the last recorded value when system/backup cannot be read (0 if none). */
  backupBytes: number;
  reserveBytes: number;
  baselineBytes: number;
  totalBytes: number;
  /** Counter value replaced by the recount (null when unknown): the day's accounting drift. */
  counterBefore: number | null;
  level: QuotaStatus["level"];
}

async function backupBytesNow(now: Date): Promise<number> {
  try {
    const bytes = await readRetainedBackupBytes(db(), now);
    await setBackupBytes(bytes, now);
    return bytes;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "r2-storage-gauge: backup bytes not recounted, last value kept");
    return (await readBackupBytes()) ?? 0;
  }
}

export async function r2StorageGauge(now = new Date()): Promise<R2StorageGaugeResult | null> {
  if (!isFirestoreConfigured()) {
    logger.warn("r2-storage-gauge skipped: Firebase not configured");
    return null;
  }
  const mediaBytes = await sumStoredBytes();
  const backupBytes = await backupBytesNow(now);
  const baselineBytes = serverEnv().R2_STORAGE_BASELINE_BYTES;
  const counterBefore = await readMediaBytes();
  const status = await resetMediaBytes(mediaBytes, now);
  const result: R2StorageGaugeResult = {
    mediaBytes,
    backupBytes,
    reserveBytes: MAP_TILES_RESERVE_BYTES,
    baselineBytes,
    totalBytes: mediaBytes + backupBytes + MAP_TILES_RESERVE_BYTES + baselineBytes,
    counterBefore,
    level: status?.level ?? "unknown",
  };
  logger.info({ ...result }, "r2-storage-gauge");
  return result;
}
