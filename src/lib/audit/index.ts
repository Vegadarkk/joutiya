import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { COLLECTIONS, auditLogSchema, type AuditLogDoc } from "@/lib/db/schemas";
import { pepperedHash } from "@/lib/security/hash";

// auditLogs (§5): append-only. Staff actions (roles, sanctions, config) and automated system
// actions (purges). Nobody updates or deletes an entry; a daily export to the private bucket
// comes with phase 5.

export interface AuditInput extends Omit<AuditLogDoc, "at" | "ipHash"> {
  /** Clear IP of the actor; stored as an HMAC. */
  ip?: string;
  at?: Date;
}

export async function audit(input: AuditInput): Promise<void> {
  const { ip, at = new Date(), ...rest } = input;
  const document = auditLogSchema.parse({ ...rest, ...(ip ? { ipHash: pepperedHash("ip", ip) } : {}), at });
  logger.info({ audit: { action: document.action, target: document.target, actorRole: document.actorRole } }, "audit");
  if (!isFirebaseConfigured()) return;
  try {
    await db()
      .collection(COLLECTIONS.auditLogs)
      .add({ ...document, at: Timestamp.fromDate(at) });
  } catch (error) {
    logger.error({ err: (error as Error).message, action: input.action }, "audit log failed");
  }
}
