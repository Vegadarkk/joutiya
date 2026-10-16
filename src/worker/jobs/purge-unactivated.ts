import { deleteAccountDocuments, listPendingAccounts } from "@/lib/db/repositories/users";
import { auth, isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";

// §6: an account without a role claim can do nothing; still pending 24 h after sign-up, it is
// deleted (Auth record, then users/{uid}, its private document and the emailIndex entry).

export const PURGE_AFTER_MS = 24 * 3_600_000;
export const PURGE_BATCH = 200;

function isUserNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "auth/user-not-found";
}

export async function purgeUnactivated(now = new Date()): Promise<{ purged: number; failed: number }> {
  if (!isFirebaseConfigured()) {
    logger.warn("purge-unactivated skipped: Firebase not configured");
    return { purged: 0, failed: 0 };
  }
  if (await isDegraded("firestore.deletes")) {
    logger.warn("purge-unactivated deferred: Firestore delete quota degraded");
    return { purged: 0, failed: 0 };
  }
  const uids = await listPendingAccounts(new Date(now.getTime() - PURGE_AFTER_MS), PURGE_BATCH);
  let purged = 0;
  let failed = 0;
  for (const uid of uids) {
    try {
      await auth()
        .deleteUser(uid)
        .catch((error: unknown) => {
          if (!isUserNotFound(error)) throw error;
        });
      await deleteAccountDocuments(uid);
      purged += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: (error as Error).message }, "purge-unactivated: account not purged");
    }
  }
  // Three documents per account (users, private/account, emailIndex).
  if (purged > 0) await consume("firestore.deletes", purged * 3);
  logger.info({ purged, failed }, "purge-unactivated");
  return { purged, failed };
}
