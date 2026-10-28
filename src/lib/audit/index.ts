import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { COLLECTIONS, auditLogSchema, type AuditLogDoc } from "@/lib/db/schemas";
import { pepperedHash } from "@/lib/security/hash";

// auditLogs (§5): append-only. Staff actions (roles, sanctions, config) and automated system
// actions (purges). Nobody updates or deletes an entry; the daily export to the private bucket
// (phase 5, D23) is the durable copy, and the nightly retention-purge deletes entries past
// `purgeAt` (§7 table: 5 years, D22). Entries written before phase 5 carry no purgeAt and stay.

export const AUDIT_RETENTION_YEARS = 5;

export interface AuditInput extends Omit<AuditLogDoc, "at" | "ipHash" | "purgeAt"> {
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

/** `at` + 5 calendar years (UTC). */
export function auditPurgeAt(at: Date): Date {
  const purgeAt = new Date(at.getTime());
  purgeAt.setUTCFullYear(purgeAt.getUTCFullYear() + AUDIT_RETENTION_YEARS);
  return purgeAt;
}

export async function audit(input: AuditInput, options: AuditOptions = {}): Promise<void> {
  const { ip, at = new Date(), ...rest } = input;
  const purgeAt = auditPurgeAt(at);
  const document = auditLogSchema.parse({ ...rest, ...(ip ? { ipHash: pepperedHash("ip", ip) } : {}), at, purgeAt });
  logger.info({ audit: { action: document.action, target: document.target, actorRole: document.actorRole } }, "audit");
  if (!isFirebaseConfigured()) return;
  try {
    await db()
      .collection(COLLECTIONS.auditLogs)
      .add({ ...document, at: Timestamp.fromDate(at), purgeAt: Timestamp.fromDate(purgeAt) });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.error({ err: (error as Error).message, action: input.action }, "audit log failed");
    if (options.required) throw unavailable("audit log unavailable");
  }
}
