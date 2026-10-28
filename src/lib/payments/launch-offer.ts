import "server-only";
import type { LaunchOffer, PricingConfig } from "@/config/pricing";
import { audit } from "@/lib/audit";
import { getFlags, getPricing } from "@/lib/config/runtime";
import { getProProfile, listLaunchOfferProfiles, markLaunchOfferNotice, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient } from "@/lib/mail/recipients";
import { transition } from "@/lib/pro/lifecycle";
import { pauseListingsOverQuota } from "@/lib/pro/quota";
import { headroom } from "@/lib/quota";
import { profileAfter } from "./subscriptions";

// End of the launch offer (phase 7 design D3), run by the nightly pro-plans job once the admin has
// set `config/pricing.launchOffer.endsAt` with the sales open: each verified shop still on the
// offer gets a notice at J-noticeDays, J-7 and J-1 (one mail per step, `launchOfferNoticeSentAt`),
// then at `endsAt` the transition `launch_offer_ended` (downgraded, plan none), an audit entry,
// its listings over the free quota paused, and a last mail. A shop that subscribed meanwhile is
// on planSource "subscription" and is left alone. Each run sends at most what Resend's quotas leave
// under LAUNCH_OFFER_RESEND_SHARE (non-security mail is dropped at 90 %): the shops past that wait
// for the next night, their notice still due and their offer kept until their last mail can go.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Steps after the first notice (`noticeDays`), in days before the end. */
const LATER_NOTICES = [7, 1];
const PAGE = 100;
const MAX_PAGES = 50;
export const LAUNCH_OFFER_MAX_MAILS = 50;
export const LAUNCH_OFFER_RESEND_SHARE = 0.6;

/** Mails this run may send: the per-run cap, and what is left under the share of both Resend quotas. */
export async function mailBudget(): Promise<number> {
  const [daily, monthly] = await Promise.all([headroom("resend.daily", LAUNCH_OFFER_RESEND_SHARE), headroom("resend.monthly", LAUNCH_OFFER_RESEND_SHARE)]);
  return Math.min(LAUNCH_OFFER_MAX_MAILS, daily ?? LAUNCH_OFFER_MAX_MAILS, monthly ?? LAUNCH_OFFER_MAX_MAILS);
}

/** The notice step due now (days before the end), or null: none yet, past the end, or already sent. */
export function noticeDue(offer: LaunchOffer, sentAt: Date | undefined, now: Date): number | null {
  if (!offer.endsAt) return null;
  const endsAt = Date.parse(offer.endsAt);
  if (now.getTime() >= endsAt) return null;
  const steps = [...new Set([offer.noticeDays, ...LATER_NOTICES])].filter((days) => days > 0 && days <= offer.noticeDays).sort((a, b) => a - b);
  const due = steps.find((days) => now.getTime() >= endsAt - days * DAY_MS);
  if (due === undefined) return null;
  return sentAt && sentAt.getTime() >= endsAt - due * DAY_MS ? null : due;
}

export interface LaunchOfferRun {
  noticed: number;
  ended: number;
  failed: number;
  /** Shops left for the next night: no mail budget left. */
  deferred?: true;
}

export async function runLaunchOfferEnd(now = new Date()): Promise<LaunchOfferRun> {
  const run: LaunchOfferRun = { noticed: 0, ended: 0, failed: 0 };
  const [pricing, flags] = await Promise.all([getPricing(), getFlags()]);
  const offer = pricing.launchOffer;
  const endsAt = offer.endsAt;
  if (!endsAt) return run;
  // A shop must be able to subscribe before it loses the offer.
  if (!flags.salesEnabled) {
    logger.warn({ endsAt }, "launch offer end date set while sales are closed: nothing done");
    return run;
  }
  const ended = now.getTime() >= Date.parse(endsAt);
  const freeListings = pricing.pro.none.activeListings;
  let budget = await mailBudget();
  let after: string | null = null;
  pages: for (let page = 0; page < MAX_PAGES; page += 1) {
    const { profiles, next } = await listLaunchOfferProfiles(after, PAGE);
    for (const profile of profiles) {
      if (profile.lifecycle !== "verified") continue;
      // Null past the end: the shop is downgraded instead.
      const due = noticeDue(offer, profile.launchOfferNoticeSentAt, now);
      if (!ended && due === null) continue;
      if (budget <= 0) {
        run.deferred = true;
        break pages;
      }
      budget -= 1;
      try {
        if (due === null) {
          if (await endLaunchOffer(profile.proId, endsAt, pricing, now)) run.ended += 1;
        } else {
          await notify(profile, { kind: "ending", endsAt, freeListings, paused: 0 }, `ending-${due}-${Date.parse(endsAt)}`);
          await markLaunchOfferNotice(profile.proId, now);
          run.noticed += 1;
        }
      } catch (error) {
        run.failed += 1;
        logger.error({ proId: profile.proId, err: (error as Error).message }, "launch offer end: one shop not handled");
      }
    }
    if (!next) break;
    after = next;
  }
  if (run.deferred) logger.warn({ ...run }, "launch offer end: mail budget used up, the other shops wait for the next night");
  else if (run.noticed + run.ended + run.failed > 0) logger.info({ ...run }, "launch offer end done");
  return run;
}

/** Downgrades one shop still on the offer (re-read in the transaction); false when it moved meanwhile. */
async function endLaunchOffer(proId: string, endsAt: string, pricing: PricingConfig, now: Date): Promise<boolean> {
  const ended = await db().runTransaction(async (tx) => {
    const profile = await getProProfile(proId, tx);
    if (!profile || profile.lifecycle !== "verified" || profile.planSource !== "launch_offer") return null;
    const { patch } = transition(profile, { type: "launch_offer_ended" }, { now, graceDays: pricing.graceDays });
    tx.set(proProfileRef(proId), proProfileToFirestore(profileAfter(profile, patch, pricing, now)));
    return profile;
  });
  if (!ended) return false;
  await audit({ actorUid: "system", actorRole: "system", action: "pro.launch_offer.ended", target: { type: "pro", id: proId }, automated: true, at: now }).catch((error: unknown) =>
    logger.error({ proId, err: (error as Error).message }, "launch offer audit failed"),
  );
  let paused: string[] = [];
  try {
    paused = await pauseListingsOverQuota(ended.ownerUid, pricing.pro.none.activeListings, now);
  } catch (error) {
    // The next subscription sync or a manual check pauses them; the mail says what was done.
    logger.error({ proId, err: (error as Error).message }, "quota pause failed");
  }
  try {
    await notify(ended, { kind: "ended", endsAt, freeListings: pricing.pro.none.activeListings, paused: paused.length }, `ended-${Date.parse(endsAt)}`);
  } catch (error) {
    logger.warn({ proId, err: (error as Error).message }, "launch offer end mail not sent");
  }
  return true;
}

async function notify(profile: ProProfileRecord, data: { kind: "ending" | "ended"; endsAt: string; freeListings: number | null; paused: number }, key: string): Promise<void> {
  const to = await listingRecipient(profile.ownerUid);
  // Closed or banned owner: nothing to send.
  if (!to) return;
  const plan = profile.plan === "business" ? "business" : "essentiel";
  await sendMail({
    template: "launchOfferNotice",
    locale: to.locale,
    to: to.email,
    priority: "transactional",
    idempotencyKey: `launchOffer-${profile.proId}-${key}`,
    data: { displayName: to.displayName, shopName: profile.name, plan, ...data },
  });
}
