import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { COLLECTIONS, connectionLogSchema, type ConnectionLogDoc } from "@/lib/db/schemas";

// connectionLogs (§5, décret 2021-1362): uid, event, IP in clear, purged after one year (§7
// retention table) by the nightly purge-connection-logs job. Written on sign-up and sign-in; read
// by an admin only, under a requisition. Never throws: a logging failure must not block a sign-in,
// but it is reported.

/** One calendar year (UTC), like contentOps: 365 days would fall a day short after a 29 February. */
export const CONNECTION_LOG_RETENTION_MONTHS = 12;

/** Firestore batches hold 500 writes at most. */
const MAX_BATCH = 500;

export function connectionLogPurgeAt(at: Date): Date {
  const purgeAt = new Date(at.getTime());
  purgeAt.setUTCMonth(purgeAt.getUTCMonth() + CONNECTION_LOG_RETENTION_MONTHS);
  return purgeAt;
}

const logs = () => db().collection(COLLECTIONS.connectionLogs);

export async function logConnection(entry: Omit<ConnectionLogDoc, "at" | "purgeAt"> & { at?: Date }): Promise<void> {
  const at = entry.at ?? new Date();
  const document = connectionLogSchema.parse({ ...entry, at, purgeAt: connectionLogPurgeAt(at) });
  if (!isFirebaseConfigured()) return;
  try {
    await logs().add({ ...document, at: Timestamp.fromDate(document.at), purgeAt: Timestamp.fromDate(document.purgeAt) });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.error({ err: (error as Error).message, event: entry.event }, "connection log failed");
  }
}

/**
 * Deletes up to `limit` (one batch, 500 at most) entries whose purgeAt is <= now, oldest first;
 * returns how many. The query uses the automatic single-field index on purgeAt.
 */
export async function deleteConnectionLogsPastPurge(now: Date, limit: number): Promise<number> {
  if (limit < 1) return 0;
  const snapshot = await logs()
    .where("purgeAt", "<=", Timestamp.fromDate(now))
    .limit(Math.min(Math.floor(limit), MAX_BATCH))
    .select()
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.empty) return 0;
  const batch = db().batch();
  for (const doc of snapshot.docs) batch.delete(doc.ref);
  await batch.commit();
  void consume("firestore.deletes", snapshot.size);
  return snapshot.size;
}

/** purgeAt of the oldest entry still past purgeAt (backlog alert), or null. */
export async function oldestConnectionLogPastPurge(now: Date): Promise<Date | null> {
  const snapshot = await logs().where("purgeAt", "<=", Timestamp.fromDate(now)).orderBy("purgeAt", "asc").limit(1).select("purgeAt").get();
  void consume("firestore.reads", 1);
  const value: unknown = snapshot.docs[0]?.get("purgeAt");
  return value instanceof Timestamp ? value.toDate() : null;
}
