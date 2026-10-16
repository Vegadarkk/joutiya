import { activateMember } from "@/lib/auth/activation";
import { deleteAccountDocumentsIfPending, listPendingAccounts } from "@/lib/db/repositories/users";
import { auth, isFirebaseConfigured } from "@/lib/firebase/admin";
import { readClaims } from "@/lib/firebase/claims";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";

// §6: an account without a role claim can do nothing; still pending 24 h after sign-up, it is
// deleted. The Auth record decides: verified in the meantime (link clicked after the query, or an
// activation that failed half-way), the member is activated instead. The documents are deleted in
// one transaction that re-checks the pending state, so an activation that lands between the query
// and the purge keeps the account (its Auth record is then left alone). Documents go first and the
// Auth record last: an orphan Auth record has no role and is harmless, while a profile without
// its Auth record would be listed again every hour. A uid that failed is skipped on the next run
// so it never starves the batch; it is retried the run after.

export const PURGE_AFTER_MS = 24 * 3_600_000;
export const PURGE_BATCH = 200;

export interface PurgeResult {
  purged: number;
  activated: number;
  failed: number;
  /** uids skipped because they failed in the previous run of this process. */
  skipped: number;
}

let failedLastRun: ReadonlySet<string> = new Set();

/** Tests: forgets the uids that failed in the previous run. */
export function resetPurgeMemory(): void {
  failedLastRun = new Set();
}

function isUserNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "auth/user-not-found";
}

export async function purgeUnactivated(now = new Date()): Promise<PurgeResult> {
  const none: PurgeResult = { purged: 0, activated: 0, failed: 0, skipped: 0 };
  if (!isFirebaseConfigured()) {
    logger.warn("purge-unactivated skipped: Firebase not configured");
    return none;
  }
  if (await isDegraded("firestore.deletes")) {
    logger.warn("purge-unactivated deferred: Firestore delete quota degraded");
    return none;
  }
  const uids = await listPendingAccounts(new Date(now.getTime() - PURGE_AFTER_MS), PURGE_BATCH);
  const skip = failedLastRun;
  const failures = new Set<string>();
  let purged = 0;
  let activated = 0;
  let skipped = 0;
  for (const uid of uids) {
    if (skip.has(uid)) {
      skipped += 1;
      continue;
    }
    try {
      const record = await auth()
        .getUser(uid)
        .catch((error: unknown) => {
          if (isUserNotFound(error)) return undefined;
          throw error;
        });
      if (record?.emailVerified) {
        if (!(await activateMember(uid, readClaims(record.customClaims ?? {})))) throw new Error("verified account could not be activated");
        activated += 1;
        continue;
      }
      if (!(await deleteAccountDocumentsIfPending(uid))) {
        // Activated, or already purged, since the query: nothing to delete, the Auth record stays.
        logger.debug({ uid }, "purge-unactivated: account no longer pending");
        continue;
      }
      if (record) {
        await auth()
          .deleteUser(uid)
          .catch((error: unknown) => {
            if (!isUserNotFound(error)) throw error;
          });
      }
      purged += 1;
    } catch (error) {
      failures.add(uid);
      logger.warn({ err: (error as Error).message }, "purge-unactivated: account not purged");
    }
  }
  failedLastRun = failures;
  // Three documents per account (users, private/account, emailIndex).
  if (purged > 0) await consume("firestore.deletes", purged * 3);
  const result: PurgeResult = { purged, activated, failed: failures.size, skipped };
  logger.info(result, "purge-unactivated");
  return result;
}
