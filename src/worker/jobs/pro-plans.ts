import { listLiveSubscriptions, touchSubscriptionSynced } from "@/lib/db/repositories/billing";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { runLaunchOfferEnd, type LaunchOfferRun } from "@/lib/payments/launch-offer";
import { runPassExpiry, type PassExpiryRun } from "@/lib/payments/pass";
import { pastDue } from "@/lib/payments/stripe-events";
import { endGrace, syncShopSubscription } from "@/lib/payments/subscriptions";

// Nightly Pro plans (phase 7 design §7, D3):
// 1. The running shop subscriptions re-synced from RevenueCat, the least recently synced first:
//    the monthly grant of a yearly plan, a renewal or an expiry whose webhook was lost, the end of a
//    grace RevenueCat reports. A grace opened from Stripe (`startGrace`) while RevenueCat still shows
//    the plan paid is not synced back to active while Stripe says past due: it ends at `graceUntil`.
// 2. The end of the launch offer (notices, then downgrade) once its end date is set.
// 3. The end of each Pass Boutique (notices at J-7 and J-1, then downgrade without grace).
// One failure is logged and counted; the next night retries it. A subscription skipped or failed has
// its `syncedAt` touched so it cannot hold the head of the queue night after night.

export const SYNC_BATCH = 200;

export interface ProPlansResult {
  synced: number;
  graceEnded: number;
  failed: number;
  launchOffer: LaunchOfferRun;
  pass: PassExpiryRun;
}

export async function proPlansNightly(now = new Date()): Promise<ProPlansResult> {
  const result: ProPlansResult = { synced: 0, graceEnded: 0, failed: 0, launchOffer: { noticed: 0, ended: 0, failed: 0 }, pass: { noticed: 0, ended: 0, failed: 0 } };
  if (!isFirebaseConfigured()) {
    logger.warn("pro-plans skipped: Firebase not configured");
    return result;
  }
  for (const { accountId, subscription } of await listLiveSubscriptions(SYNC_BATCH)) {
    if (!accountId.startsWith("pro_")) continue;
    const proId = accountId.slice("pro_".length);
    try {
      if (subscription.store === "stripe" && (subscription.status === "active" || subscription.status === "cancelled")) {
        const profile = await getProProfile(proId);
        if ((profile?.lifecycle === "grace" || profile?.lifecycle === "downgraded") && (await pastDue(subscription.storeSubscriptionId))) {
          if (profile.lifecycle === "grace" && (await endGrace(proId, now))) result.graceEnded += 1;
          await touchSubscriptionSynced(accountId, now);
          continue;
        }
      }
      const outcome = await syncShopSubscription(accountId, { now: () => now });
      if (outcome === "updated") result.synced += 1;
      else if (outcome === "no_shop" || outcome === "no_subscription") await touchSubscriptionSynced(accountId, now);
    } catch (error) {
      result.failed += 1;
      logger.error({ proId, err: (error as Error).message }, "pro-plans: one subscription not synced");
      await touchSubscriptionSynced(accountId, now).catch(() => undefined);
    }
  }
  try {
    result.launchOffer = await runLaunchOfferEnd(now);
  } catch (error) {
    result.launchOffer.failed += 1;
    logger.error({ err: (error as Error).message }, "pro-plans: launch offer end failed");
  }
  try {
    result.pass = await runPassExpiry(now);
  } catch (error) {
    result.pass.failed += 1;
    logger.error({ err: (error as Error).message }, "pro-plans: pass expiry failed");
  }
  if (result.synced + result.graceEnded + result.failed > 0) logger.info({ synced: result.synced, graceEnded: result.graceEnded, failed: result.failed }, "pro-plans done");
  return result;
}
