import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { proProfileRef } from "@/lib/db/repositories/pro-profiles";
import { getClaims, updateClaims } from "@/lib/firebase/claims";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { retagOwnerListings } from "./retag";

// Effects of a KYBC verification that run after the profile transaction (phase 7 design §4,
// lifecycle `grantProClaims` and `retagListings`): the Pro claims (sessions revoked, the owner
// signs in again) and the retag of the owner's listings. Firebase Auth is outside the Firestore
// transaction, so either can fail after the commit; both are idempotent and the failure is
// recorded on the profile (`effectsPendingSince`) and alerted, then rerun by the nightly
// pro-effects-sync or by the moderator's verify again (src/lib/pro/review.ts). Without this a
// transient Auth error left `users.type = "pro"` without the claims for good.

export interface EffectsOutcome {
  /** Both effects done (the retag complete). */
  ok: boolean;
  retagged: number;
  claimsGranted: boolean;
}

/** The owner carries the claims of this shop. */
export async function hasProClaims(uid: string, proId: string): Promise<boolean> {
  const claims = await getClaims(uid);
  return claims.role === "pro" && claims.proId === proId;
}

/**
 * Grants the claims when the owner lacks them (a rerun never revokes the sessions of an owner
 * already Pro) and retags the listings; records the outcome on the profile. Never throws.
 */
export async function applyVerificationEffects(uid: string, proId: string, now = new Date()): Promise<EffectsOutcome> {
  const outcome: EffectsOutcome = { ok: true, retagged: 0, claimsGranted: false };
  try {
    if (!(await hasProClaims(uid, proId))) {
      await updateClaims(uid, { role: "pro", proId, proRole: "owner" });
      outcome.claimsGranted = true;
    }
  } catch (error) {
    outcome.ok = false;
    logger.error({ err: (error as Error).message, proId }, "pro claims grant failed");
  }
  try {
    const retag = await retagOwnerListings(uid, proId, now);
    outcome.retagged = retag.retagged;
    if (!retag.complete) outcome.ok = false;
  } catch (error) {
    outcome.ok = false;
    logger.error({ err: (error as Error).message, proId }, "pro listings retag failed");
  }
  await recordEffects(proId, outcome.ok ? null : now);
  if (!outcome.ok) {
    await alert({
      severity: "P2",
      title: "Effets d'une validation Pro en attente",
      body: `La boutique ${proId} est validée mais ses droits Pro ou le marquage de ses annonces n'ont pas pu être appliqués. La tâche pro-effects-sync réessaie chaque nuit ; un modérateur peut relancer la validation depuis la fiche.`,
    });
  }
  return outcome;
}

/** `effectsPendingSince` set (a failure at `at`) or cleared (null); a failed write is only logged. */
async function recordEffects(proId: string, at: Date | null): Promise<void> {
  try {
    await proProfileRef(proId).update({ effectsPendingSince: at ? Timestamp.fromDate(at) : FieldValue.delete() });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.error({ err: (error as Error).message, proId }, "pro effects status not recorded");
  }
}
