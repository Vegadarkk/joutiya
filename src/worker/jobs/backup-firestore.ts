import type { Firestore } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { alertBackupSkipped, authUserLister, checkBackupFreshness, runBackup, skippedBackup, type AuthUserLister, type BackupFreshness, type BackupResult } from "@/lib/backup/export";
import { serverEnv } from "@/lib/env";
import { auth, db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { setGauge } from "@/lib/quota";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { setBackupBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:30 UTC (D17): encrypted export of Firestore to the private bucket
// (src/lib/backup/export.ts). A missing or invalid BACKUP_AGE_RECIPIENT, or no R2, alerts once a
// day and writes nothing. A failure alerts and fails the job without retries (the backup has
// one attempt): the cursors did not move, so the next night redoes the work. A completed run
// hands the bytes of the backups still in the private bucket to the R2 storage gauge, and the
// Firestore storage estimated from the last complete rolling full to its gauge (every night, so the
// monthly key always holds it; nothing until a first cycle completed). The Firebase Auth accounts
// go with it (D20). backup-freshness (09:05 UTC) alerts when the last completed run is over 26 h old.

export interface BackupJobDeps {
  db?: Firestore;
  store?: ObjectStore;
  recipient?: string | undefined;
  /** Firebase Auth accounts (default: the Admin SDK's listUsers when `db` is the Admin SDK's too; none with an injected `db`). */
  authUsers?: AuthUserLister | null;
}

export async function backupFirestore(now = new Date(), deps: BackupJobDeps = {}): Promise<BackupResult | null> {
  if (!deps.db && !isFirestoreConfigured()) {
    logger.warn("backup-firestore skipped: Firebase not configured");
    return null;
  }
  const date = now.toISOString().slice(0, 10);
  let store: ObjectStore;
  try {
    store = deps.store ?? objectStore();
  } catch (error) {
    if (!isStorageNotConfigured(error)) throw error;
    logger.warn({ date }, "backup-firestore skipped: object storage not configured");
    await alertBackupSkipped(date, "no_storage");
    return skippedBackup("no_storage", date);
  }
  const recipient = "recipient" in deps ? deps.recipient : serverEnv().BACKUP_AGE_RECIPIENT;
  let result: BackupResult;
  try {
    const authUsers = "authUsers" in deps ? deps.authUsers : deps.db ? null : authUserLister(auth());
    result = await runBackup({ db: deps.db ?? db(), store, recipient, now, authUsers });
  } catch (error) {
    const message = (error as Error).message.slice(0, 200);
    await alert({ severity: "P1", title: "Sauvegarde Firestore en échec", body: `La sauvegarde du ${date} a échoué (${(error as Error).name}: ${message}). Les curseurs n'ont pas bougé : la nuit suivante reprend le même travail.` });
    throw error;
  }
  if (result.retainedBytes !== null) await setBackupBytes(result.retainedBytes, now);
  if (result.firestoreStorageBytes !== null) await setGauge("firestore.storage", result.firestoreStorageBytes, now);
  return result;
}

/** Daily at 09:05 UTC (D20): P1 when the last completed backup is over 26 h old. */
export async function backupFreshness(now = new Date(), deps: Pick<BackupJobDeps, "db"> = {}): Promise<BackupFreshness | null> {
  if (!deps.db && !isFirestoreConfigured()) return null;
  return checkBackupFreshness(deps.db ?? db(), now);
}
