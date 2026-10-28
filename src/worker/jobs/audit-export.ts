import { FieldPath, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { encryptAge, isAgeRecipient } from "@/lib/backup/crypto";
import { encodeDocument } from "@/lib/backup/encode";
import { sealPart } from "@/lib/backup/parts";
import { COLLECTIONS } from "@/lib/db/schemas";
import { serverEnv } from "@/lib/env";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";

// Daily at 03:22 UTC (design D23, AF §5 "auditLogs ... export quotidien vers R2 privé"): the
// auditLogs of each finished UTC day -> NDJSON in the backup line format (src/lib/backup/encode.ts,
// so scripts/restore-firestore.ts tooling reads it) -> gzip -> age for BACKUP_AGE_RECIPIENT
// (sealPart), object `audit/{YYYY-MM-DD}.ndjson.gz.age` in the private bucket. A day with no entry
// still gets its object (the export ran). Cursor system/auditExport {through}: the last day
// exported; a missed night is caught up, AUDIT_EXPORT_MAX_DAYS days a run, oldest first, and an
// object already there is never rewritten. Without a valid recipient or object storage nothing is
// written (never in clear) and a P1 alert goes out; a failure alerts and fails the job (the cursor
// did not move: the next night redoes that day). The R2 lifecycle of `audit/` is 5 years
// (AF §7 retention table), set in infra/cloudflare/r2-buckets.json by the owner's steps.

export const AUDIT_EXPORT_MAX_DAYS = 7;
export const AUDIT_EXPORT_PAGE = 500;
const CONTENT_TYPE = "application/octet-stream";
const CURSOR_DOC = "auditExport";
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditExportDay {
  date: string;
  key: string;
  docs: number;
  /** Encrypted bytes written; 0 when the object was already there. */
  bytes: number;
  existed: boolean;
}

export interface AuditExportResult {
  status: "done" | "skipped";
  reason?: "no_recipient" | "no_storage" | "quota" | "not_configured";
  days: AuditExportDay[];
}

export interface AuditExportDeps {
  db?: Firestore;
  store?: ObjectStore;
  recipient?: string | undefined;
}

export function auditExportKey(date: string): string {
  return `audit/${date}.ndjson.gz.age`;
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * UTC days to export on `now`: after `through` (the cursor) up to yesterday, oldest first, at most
 * AUDIT_EXPORT_MAX_DAYS; yesterday alone without a cursor.
 */
export function exportDays(now: Date, through: string | null): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday = today - DAY_MS;
  let start = yesterday;
  if (through && DATE.test(through)) start = Date.parse(`${through}T00:00:00Z`) + DAY_MS;
  const days: string[] = [];
  for (let at = start; at <= yesterday && days.length < AUDIT_EXPORT_MAX_DAYS; at += DAY_MS) days.push(dayOf(at));
  return days;
}

/** A syntactically valid recipient can still carry a bad checksum: encrypting nothing proves it. */
async function usableRecipient(recipient: string | undefined): Promise<boolean> {
  if (!isAgeRecipient(recipient)) return false;
  try {
    await encryptAge(new Uint8Array(0), recipient);
    return true;
  } catch {
    return false;
  }
}

const SKIP_ALERT: Record<"no_recipient" | "no_storage", string> = {
  no_recipient: "BACKUP_AGE_RECIPIENT absent ou invalide : le journal d'audit n'est pas exporté (jamais en clair). Renseigner la clé publique age1… dans l'environnement du worker ; les jours manqués seront rattrapés.",
  no_storage: "Variables R2_* absentes : le journal d'audit n'est pas exporté. Renseigner les variables R2 dans l'environnement du worker ; les jours manqués seront rattrapés.",
};

async function skipped(reason: "no_recipient" | "no_storage", date: string): Promise<AuditExportResult> {
  logger.warn({ reason, date }, "audit-export skipped");
  await alert({ severity: "P1", title: "Export du journal d'audit non effectué", body: `${SKIP_ALERT[reason]} (${date})` });
  return { status: "skipped", reason, days: [] };
}

async function readThrough(firestore: Firestore): Promise<string | null> {
  const snapshot = await firestore.collection(COLLECTIONS.system).doc(CURSOR_DOC).get();
  void consume("firestore.reads", 1);
  const through: unknown = snapshot.get("through");
  return typeof through === "string" && DATE.test(through) ? through : null;
}

async function writeThrough(firestore: Firestore, date: string, now: Date): Promise<void> {
  await firestore.collection(COLLECTIONS.system).doc(CURSOR_DOC).set({ through: date, updatedAt: Timestamp.fromDate(now) });
  void consume("firestore.writes", 1);
}

/** NDJSON lines of the auditLogs with `at` in [date 00:00, +1 day) UTC, in (at, id) order. */
async function dayLines(firestore: Firestore, date: string): Promise<string[]> {
  const start = Date.parse(`${date}T00:00:00Z`);
  const base: Query = firestore
    .collection(COLLECTIONS.auditLogs)
    .where("at", ">=", Timestamp.fromMillis(start))
    .where("at", "<", Timestamp.fromMillis(start + DAY_MS))
    .orderBy("at", "asc")
    .orderBy(FieldPath.documentId(), "asc");
  const lines: string[] = [];
  let after: { at: Timestamp; id: string } | null = null;
  for (;;) {
    if (await isDegraded("firestore.reads")) throw new AuditExportDeferred();
    const query: Query = after ? base.startAfter(after.at, after.id) : base;
    const snapshot = await query.limit(AUDIT_EXPORT_PAGE).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    for (const doc of snapshot.docs) lines.push(encodeDocument(doc));
    const last = snapshot.docs[snapshot.docs.length - 1];
    const at: unknown = last?.get("at");
    if (snapshot.size < AUDIT_EXPORT_PAGE || !last || !(at instanceof Timestamp)) return lines;
    after = { at, id: last.id };
  }
}

/** The Firestore read quota degraded mid-run: stop without writing, the next night resumes. */
class AuditExportDeferred extends Error {
  constructor() {
    super("firestore.reads degraded");
    this.name = "AuditExportDeferred";
  }
}

export async function exportAuditLogs(now = new Date(), deps: AuditExportDeps = {}): Promise<AuditExportResult> {
  const yesterday = dayOf(now.getTime() - DAY_MS);
  if (!deps.db && !isFirestoreConfigured()) {
    logger.warn("audit-export skipped: Firebase not configured");
    return { status: "skipped", reason: "not_configured", days: [] };
  }
  let store: ObjectStore;
  try {
    store = deps.store ?? objectStore();
  } catch (error) {
    if (!isStorageNotConfigured(error)) throw error;
    return skipped("no_storage", yesterday);
  }
  const recipient = "recipient" in deps ? deps.recipient : serverEnv().BACKUP_AGE_RECIPIENT;
  if (!(await usableRecipient(recipient)) || !recipient) return skipped("no_recipient", yesterday);
  if (await isDegraded("firestore.reads")) {
    logger.warn("audit-export deferred: Firestore read quota degraded");
    return { status: "skipped", reason: "quota", days: [] };
  }
  const firestore = deps.db ?? db();
  const days: AuditExportDay[] = [];
  try {
    for (const date of exportDays(now, await readThrough(firestore))) {
      const key = auditExportKey(date);
      if (await store.head("private", key)) {
        days.push({ date, key, docs: 0, bytes: 0, existed: true });
      } else {
        const lines = await dayLines(firestore, date);
        const sealed = await sealPart(lines, recipient);
        await store.put("private", key, sealed.body, { contentType: CONTENT_TYPE });
        days.push({ date, key, docs: sealed.docs, bytes: sealed.bytes, existed: false });
      }
      await writeThrough(firestore, date, now);
    }
  } catch (error) {
    if (error instanceof AuditExportDeferred) {
      logger.warn({ days: days.length }, "audit-export deferred: Firestore read quota degraded");
      return { status: "skipped", reason: "quota", days };
    }
    const message = (error as Error).message.slice(0, 200);
    await alert({ severity: "P1", title: "Export du journal d'audit en échec", body: `L'export du ${yesterday} a échoué (${(error as Error).name}: ${message}). Le curseur n'a pas bougé : la nuit suivante reprend le même jour.` });
    throw error;
  }
  logger.info({ days: days.map((day) => ({ date: day.date, docs: day.docs, bytes: day.bytes, existed: day.existed })) }, "audit-export");
  return { status: "done", days };
}
