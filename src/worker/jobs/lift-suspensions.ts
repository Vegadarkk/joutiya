import { liftSuspension } from "@/lib/decisions/sanctions";
import { listDueSuspensions } from "@/lib/decisions/repository";
import { isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";

// Hourly (design D14): suspensions whose `until` passed are lifted: `st` claim dropped, account
// active again, listings paused by moderation resumed (published when not expired), suspension
// document deleted, audit `user.unsuspend`. Not deferred on a degraded Firestore quota: an account
// must not stay suspended past the decided end, and a lift costs a handful of writes. A failure
// leaves the document in place, so the next run retries it.

export const LIFT_BATCH = 50;

export interface LiftResult {
  lifted: number;
  failed: number;
}

export async function liftSuspensions(now = new Date()): Promise<LiftResult> {
  if (!isFirebaseConfigured()) {
    logger.warn("lift-suspensions skipped: Firebase not configured");
    return { lifted: 0, failed: 0 };
  }
  const due = await listDueSuspensions(now, LIFT_BATCH);
  let lifted = 0;
  let failed = 0;
  for (const { uid } of due) {
    try {
      if (await liftSuspension(uid, { now, actor: { uid: "system", role: "system" } })) lifted += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: (error as Error).message }, "lift-suspensions: one suspension not lifted");
    }
  }
  if (due.length > 0) logger.info({ due: due.length, lifted, failed }, "lift-suspensions done");
  return { lifted, failed };
}
