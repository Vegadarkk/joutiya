import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { COLLECTIONS, connectionLogSchema, type ConnectionLogDoc } from "@/lib/db/schemas";

// connectionLogs (§5, décret 2021-1362): uid, event, IP in clear, purged after one year. Written
// on sign-up and sign-in; read by an admin only, under a requisition. Never throws: a logging
// failure must not block a sign-in, but it is reported.

const ONE_YEAR_MS = 365 * 24 * 3_600_000;

export async function logConnection(entry: Omit<ConnectionLogDoc, "at" | "purgeAt"> & { at?: Date }): Promise<void> {
  const at = entry.at ?? new Date();
  const document = connectionLogSchema.parse({ ...entry, at, purgeAt: new Date(at.getTime() + ONE_YEAR_MS) });
  if (!isFirebaseConfigured()) return;
  try {
    await db()
      .collection(COLLECTIONS.connectionLogs)
      .add({ ...document, at: Timestamp.fromDate(document.at), purgeAt: Timestamp.fromDate(document.purgeAt) });
  } catch (error) {
    logger.error({ err: (error as Error).message, event: entry.event }, "connection log failed");
  }
}
