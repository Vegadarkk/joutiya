import { listProEffectsPending } from "@/lib/db/repositories/pro-profiles";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { applyVerificationEffects } from "@/lib/pro/effects";
import { publishesAsPro } from "@/lib/pro/lifecycle";
import { isDegraded } from "@/lib/quota";

// Nightly at 03:50 UTC (phase 7 design §4): verified shops whose post-commit effects (Pro claims,
// listings retag) failed get them again (src/lib/pro/effects.ts, idempotent). A shop that left the
// Pro states meanwhile (rejected after a resubmission, suspended) is skipped and its marker
// cleared by the next decision. Bounded per night; what fails stays marked for the next run and
// the alert of the effects module says so.

export const PRO_EFFECTS_SYNC_BATCH = 50;

export interface ProEffectsSyncResult {
  /** Both effects done. */
  repaired: number;
  /** Still pending after this run (the alert went out). */
  pending: number;
  /** Not in a Pro state any more: left alone. */
  skipped: number;
}

export async function proEffectsSync(now: Date = new Date()): Promise<ProEffectsSyncResult> {
  const result: ProEffectsSyncResult = { repaired: 0, pending: 0, skipped: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("pro-effects-sync skipped: Firebase not configured");
    return result;
  }
  if (await isDegraded("firestore.writes")) {
    logger.warn("pro-effects-sync deferred: Firestore write quota degraded");
    return result;
  }
  const profiles = await listProEffectsPending(now, PRO_EFFECTS_SYNC_BATCH);
  for (const profile of profiles) {
    if (!publishesAsPro(profile.lifecycle) || profile.kybc.status !== "verified") {
      result.skipped += 1;
      continue;
    }
    const outcome = await applyVerificationEffects(profile.ownerUid, profile.proId, now);
    if (outcome.ok) result.repaired += 1;
    else result.pending += 1;
  }
  logger.info({ ...result }, "pro-effects-sync");
  return result;
}
