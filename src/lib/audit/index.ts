import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
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

export interface AuditOptions {
  /**
   * The action must not happen without its entry (a staff read of identity documents): a failed
   * write answers 503 instead of being logged. Default: logged, the action goes on.
   */
  required?: boolean;
}

export async function audit(input: AuditInput, options: AuditOptions = {}): Promise<void> {
  const { ip, at = new Date(), ...rest } = input;
  const document = auditLogSchema.parse({ ...rest, ...(ip ? { ipHash: pepperedHash("ip", ip) } : {}), at });
  logger.info({ audit: { action: document.action, target: document.target, actorRole: document.actorRole } }, "audit");
  if (!isFirebaseConfigured()) return;
  try {
    await db()
      .collection(COLLECTIONS.auditLogs)
      .add({ ...document, at: Timestamp.fromDate(at) });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.error({ err: (error as Error).message, action: input.action }, "audit log failed");
    if (options.required) throw unavailable("audit log unavailable");
  }
}
