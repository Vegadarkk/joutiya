import type { Firestore } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { alertBackupSkipped, runBackup, skippedBackup, type BackupResult } from "@/lib/backup/export";
import { serverEnv } from "@/lib/env";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";

// Nightly at 03:30 UTC (D17): encrypted export of Firestore to the private bucket
// (src/lib/backup/export.ts). A missing or invalid BACKUP_AGE_RECIPIENT, or no R2, alerts once a
// day and writes nothing. A failure alerts and fails the job without retries (system jobs have
// one attempt): the cursors did not move, so the next night redoes the work.

export interface BackupJobDeps {
  db?: Firestore;
  store?: ObjectStore;
  recipient?: string | undefined;
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
  try {
    return await runBackup({ db: deps.db ?? db(), store, recipient, now });
  } catch (error) {
    const message = (error as Error).message.slice(0, 200);
    await alert({ severity: "P1", title: "Sauvegarde Firestore en échec", body: `La sauvegarde du ${date} a échoué (${(error as Error).name}: ${message}). Les curseurs n'ont pas bougé : la nuit suivante reprend le même travail.` });
    throw error;
  }
}
