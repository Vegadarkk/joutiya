import "server-only";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { isDegraded, setGauge, type QuotaStatus } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// R2 storage gauge (D15): R2 exposes no cheap usage API, so the app counts the bytes it stores.
// valkey-queue (noeviction, AOF) holds the running total of the media bucket, moved by every
// ready photo and every deletion; the nightly r2-storage-gauge job replaces it with the sum of the
// `ready` uploads. The gauge adds R2_STORAGE_BASELINE_BYTES (the account's other project), so the
// 8 GB alert and the 9.5 GB degraded mode (uploads refused) see the account total.

export const MEDIA_BYTES_KEY = "r2:bytes:media";

function gaugeValue(mediaBytes: number): number {
  return Math.max(0, mediaBytes) + serverEnv().R2_STORAGE_BASELINE_BYTES;
}

/** Adds stored bytes (negative after a deletion) and refreshes the gauge. Never throws. */
export async function recordMediaBytes(delta: number, at = new Date()): Promise<QuotaStatus | null> {
  const bytes = Math.round(delta);
  if (bytes === 0 || !Number.isFinite(bytes) || !isValkeyConfigured("queue")) return null;
  try {
    const total = await valkey("queue").incrby(MEDIA_BYTES_KEY, bytes);
    return await setGauge("r2.storage", gaugeValue(total), at);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "media byte counter unavailable");
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

/** Nightly recount: the measured total replaces the counter, then the gauge. Never throws. */
export async function resetMediaBytes(total: number, at = new Date()): Promise<QuotaStatus | null> {
  const bytes = Math.max(0, Math.round(total));
  if (!isValkeyConfigured("queue")) return null;
  try {
    await valkey("queue").set(MEDIA_BYTES_KEY, String(bytes));
    return await setGauge("r2.storage", gaugeValue(bytes), at);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "media byte counter unavailable");
    return null;
  }
}

/** Degraded storage (9.5 GB) or Class A operations (95 %): new uploads are refused (`storage_full`). */
export async function isStorageFull(): Promise<boolean> {
  const [storage, writes] = await Promise.all([isDegraded("r2.storage"), isDegraded("r2.classA")]);
  return storage || writes;
}
