import "server-only";
import { QUOTAS } from "@/config/quotas";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { isDegraded, setGauge, type QuotaStatus } from "@/lib/quota";
import { classify } from "@/lib/quota/period";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// R2 storage gauge (D15): R2 exposes no cheap usage API, so the app counts the bytes it stores.
// valkey-queue (noeviction, AOF) holds the running total of the media bucket, moved by every
// ready photo and every deletion; the nightly r2-storage-gauge job replaces it with the sum of the
// `ready` uploads. It also holds the encrypted backups still in the private bucket (98 days, set
// by the backup job and the nightly recount from system/backup). The gauge adds the map tiles
// reserve and R2_STORAGE_BASELINE_BYTES (the account's other project), so the 8 GB alert and the
// 9.5 GB degraded mode (uploads refused) see the account total.

export const MEDIA_BYTES_KEY = "r2:bytes:media";
export const BACKUP_BYTES_KEY = "r2:bytes:backups";
/** maps/morocco.pmtiles in the media bucket (~63 MB Morocco extract, docs/phase-3.md), rounded up. */
export const MAP_TILES_RESERVE_BYTES = 64_000_000;

function gaugeValue(mediaBytes: number, backupBytes: number): number {
  return Math.max(0, mediaBytes) + Math.max(0, backupBytes) + MAP_TILES_RESERVE_BYTES + serverEnv().R2_STORAGE_BASELINE_BYTES;
}

const toBytes = (value: string | null): number => {
  const bytes = Number(value ?? 0);
  return Number.isFinite(bytes) ? bytes : 0;
};

/** Backups in the private bucket as last recorded (0 when unknown: the nightly recount restores it). Throws when Valkey fails. */
async function backupBytes(): Promise<number> {
  return toBytes(await valkey("queue").get(BACKUP_BYTES_KEY));
}

/** Adds stored bytes (negative after a deletion) and refreshes the gauge. Never throws. */
export async function recordMediaBytes(delta: number, at = new Date()): Promise<QuotaStatus | null> {
  const bytes = Math.round(delta);
  if (bytes === 0 || !Number.isFinite(bytes) || !isValkeyConfigured("queue")) return null;
  try {
    const total = await valkey("queue").incrby(MEDIA_BYTES_KEY, bytes);
    return await setGauge("r2.storage", gaugeValue(total, await backupBytes()), at);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "media byte counter unavailable");
    return null;
  }
}

/**
 * Replaces the bytes of the encrypted backups still in the private bucket (backup job, nightly
 * recount) and refreshes the gauge with the media counter; without that counter (Valkey reset) the
 * gauge waits for the next photo or recount. Never throws.
 */
export async function setBackupBytes(total: number, at = new Date()): Promise<QuotaStatus | null> {
  const bytes = Math.max(0, Math.round(total));
  if (!Number.isFinite(bytes) || !isValkeyConfigured("queue")) return null;
  try {
    await valkey("queue").set(BACKUP_BYTES_KEY, String(bytes));
    const media = await valkey("queue").get(MEDIA_BYTES_KEY);
    if (media === null) return null;
    return await setGauge("r2.storage", gaugeValue(toBytes(media), bytes), at);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "backup byte counter unavailable");
    return null;
  }
}

/** Running total of the media bucket, or null when Valkey cannot answer. */
export async function readMediaBytes(): Promise<number | null> {
  if (!isValkeyConfigured("queue")) return null;
  try {
    const value = await valkey("queue").get(MEDIA_BYTES_KEY);
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

/** Backup bytes as last recorded, or null when Valkey cannot answer. */
export async function readBackupBytes(): Promise<number | null> {
  if (!isValkeyConfigured("queue")) return null;
  try {
    return await backupBytes();
  } catch {
    return null;
  }
}

/** Nightly recount: the measured total replaces the counter, then the gauge. Never throws. */
export async function resetMediaBytes(total: number, at = new Date()): Promise<QuotaStatus | null> {
  const bytes = Math.max(0, Math.round(total));
  if (!isValkeyConfigured("queue")) return null;
  try {
    await valkey("queue").set(MEDIA_BYTES_KEY, String(bytes));
    return await setGauge("r2.storage", gaugeValue(bytes, await backupBytes()), at);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "media byte counter unavailable");
    return null;
  }
}

/**
 * Degraded storage (9.5 GB) or Class A operations (95 %): new uploads are refused (`storage_full`).
 * The storage level also comes from the running counter: the gauge lives in a daily key, empty
 * after midnight UTC until the next ready photo or the 03:10 recount.
 */
export async function isStorageFull(): Promise<boolean> {
  const [bytes, backups, storage, writes] = await Promise.all([readMediaBytes(), readBackupBytes(), isDegraded("r2.storage"), isDegraded("r2.classA")]);
  const counted = bytes !== null && Number.isFinite(bytes) && classify(QUOTAS["r2.storage"], gaugeValue(bytes, backups ?? 0)) === "degraded";
  return counted || storage || writes;
}
