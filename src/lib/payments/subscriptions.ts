import "server-only";
import { UnrecoverableError } from "bullmq";
import { listingQuotas, planOfEntitlement, type PaidPlanId, type PlanInterval, type PricingConfig } from "@/config/pricing";
import { audit } from "@/lib/audit";
import { getBillingAccount, getSubscriptionTx, setSubscriptionTx } from "@/lib/db/repositories/billing";
import { getProProfile, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { getLedgerEntryTx, getWalletTx, recordWalletOperationTx, walletStateAt } from "@/lib/db/repositories/wallets";
import type { SubscriptionDoc, SubscriptionStatus } from "@/lib/db/schemas";
import { getPricing } from "@/lib/config/runtime";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { transition, type ProEvent, type ProLifecycleView, type ProPatch } from "@/lib/pro/lifecycle";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { alignListingsWithQuota } from "@/lib/pro/quota";
import { BillingRetryError, expectedEnvironment } from "./billing-common";
import { listCustomerSubscriptions, RevenueCatApiError, type RevenueCatSubscription } from "./revenuecat-api";
import { grantPlanPeriod } from "./wallet";

// Pro subscriptions (phase 7 design §7). Stripe bills, RevenueCat is the source of truth: every
// event that may change a shop's plan (a RevenueCat subscription event, a Stripe webhook) ends in
// `syncShopSubscription`, which re-reads the customer's subscriptions from RevenueCat and writes in
// one transaction:
// - subscriptions/pro_{proId} (plan from the entitlement lookup key, status, period, renewal);
// - the Pro lifecycle transition (active, grace on a billing issue, downgraded at expiry), with the
//   plan's quotas on the profile;
// - the month's grant (`grant_{subscription}_{monthStartMs}`: plan credits and À la Une allowance
//   reset, not added; a yearly plan gets one per month of its period).
// Then the shop's listings are brought within the plan's quota. Idempotent: a replay or a second
// event for the same change writes nothing new.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A period longer than this is a yearly one (a month is at most 31 days). */
const YEARLY_PERIOD_MS = 45 * DAY_MS;

export function addMonthsUtc(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

export function intervalOf(periodStart: Date, periodEnd: Date | null): PlanInterval {
  return periodEnd && periodEnd.getTime() - periodStart.getTime() > YEARLY_PERIOD_MS ? "yearly" : "monthly";
}

/** The month of the period that contains `now`: the period itself for a monthly plan. */
export function grantSlot(periodStart: Date, periodEnd: Date | null, interval: PlanInterval, now: Date): { start: Date; end: Date } {
  if (interval === "monthly") return { start: periodStart, end: periodEnd ?? addMonthsUtc(periodStart, 1) };
  let months = 0;
  while (months < 11 && addMonthsUtc(periodStart, months + 1).getTime() <= now.getTime()) months += 1;
  const end = addMonthsUtc(periodStart, months + 1);
  return { start: addMonthsUtc(periodStart, months), end: periodEnd && periodEnd.getTime() < end.getTime() ? periodEnd : end };
}

export function subscriptionStatusOf(subscription: Pick<RevenueCatSubscription, "status" | "givesAccess" | "willRenew">): SubscriptionStatus {
  if (subscription.status === "in_grace_period") return "grace";
  if (subscription.status === "in_billing_retry") return "billing_issue";
  if (subscription.status === "expired" || !subscription.givesAccess) return "expired";
  return subscription.willRenew ? "active" : "cancelled";
}

/** The shop's plan subscription: the one giving access first, then the most recent period. */
export function chooseSubscription(subscriptions: readonly RevenueCatSubscription[], pricing: PricingConfig): { subscription: RevenueCatSubscription; plan: PaidPlanId } | null {
  const candidates = subscriptions.flatMap((subscription) => {
    const plans = subscription.entitlements.map((key) => planOfEntitlement(key, pricing)).filter((plan) => plan !== undefined);
    const plan = plans.includes("business") ? "business" : plans[0];
    return plan ? [{ subscription, plan }] : [];
  });
  candidates.sort((a, b) => Number(b.subscription.givesAccess) - Number(a.subscription.givesAccess) || b.subscription.periodStart.getTime() - a.subscription.periodStart.getTime());
  return candidates[0] ?? null;
}

/** Statuses that pay for the plan now (a cancelled plan runs until its period ends). */
const PAID: ReadonlySet<SubscriptionStatus> = new Set(["active", "cancelled"]);

/** The lifecycle event the subscription calls for, if any (a suspended or unverified shop waits). */
export function lifecycleEventFor(profile: ProLifecycleView, status: SubscriptionStatus, plan: PaidPlanId, now: Date): ProEvent | null {
  const { lifecycle } = profile;
  if (lifecycle !== "verified" && lifecycle !== "active" && lifecycle !== "grace" && lifecycle !== "downgraded") return null;
  if (PAID.has(status)) return lifecycle === "active" && profile.plan === plan && profile.planSource === "subscription" ? null : { type: "subscription_active", plan };
  if (status === "grace" || status === "billing_issue") {
    if (lifecycle === "active") return { type: "billing_issue" };
    return lifecycle === "grace" && profile.graceUntil !== undefined && profile.graceUntil.getTime() <= now.getTime() ? { type: "grace_ended" } : null;
  }
  return (lifecycle === "active" || lifecycle === "grace") && profile.planSource === "subscription" ? { type: "subscription_expired" } : null;
}

/** The profile after a transition: `null` in the patch clears a field; quotas follow the plan. */
export function profileAfter(profile: ProProfileRecord, patch: ProPatch, pricing: PricingConfig, now: Date): ProProfileDoc {
  const { proId: _proId, ...doc } = profile;
  const { graceUntil, suspendedFrom, ...rest } = patch;
  const next: ProProfileDoc = { ...doc, ...rest, quotas: listingQuotas({ type: "pro", plan: patch.plan }, pricing), updatedAt: now };
  if (graceUntil === null) delete next.graceUntil;
  else if (graceUntil) next.graceUntil = graceUntil;
  if (suspendedFrom === null) delete next.suspendedFrom;
  else if (suspendedFrom) next.suspendedFrom = suspendedFrom;
  return next;
}

export type SyncOutcome = "updated" | "unchanged" | "no_subscription" | "no_shop";

export interface SyncDeps {
  listSubscriptions?: typeof listCustomerSubscriptions;
  now?: () => Date;
  eventId?: string;
}

async function subscriptionsOf(appUserId: string, deps: SyncDeps): Promise<RevenueCatSubscription[]> {
  const list = deps.listSubscriptions ?? listCustomerSubscriptions;
  try {
    return await list(appUserId, expectedEnvironment() === "PRODUCTION" ? "production" : "sandbox");
  } catch (error) {
    if (error instanceof RevenueCatApiError && !error.retryable) throw new UnrecoverableError(error.message);
    throw new BillingRetryError((error as Error).message);
  }
}

/** Ledger ids keep to the characters the wallet page's cursor accepts. */
const ledgerKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

/** Brings the shop's subscription, lifecycle, grant and listings in line with RevenueCat. */
export async function syncShopSubscription(accountId: string, deps: SyncDeps = {}): Promise<SyncOutcome> {
  const account = await getBillingAccount(accountId);
  if (!account || account.kind !== "shop" || !account.proId) return "no_shop";
  const proId = account.proId;
  const [pricing, subscriptions] = await Promise.all([getPricing(), subscriptionsOf(account.rcAppUserId, deps)]);
  const chosen = chooseSubscription(subscriptions, pricing);
  const now = deps.now?.() ?? new Date();

  const result = await db().runTransaction(async (tx) => {
    const profile = await getProProfile(proId, tx);
    const before = await getSubscriptionTx(tx, accountId);
    if (!profile) return { outcome: "no_shop" as const };
    if (!chosen && (!before || before.status === "expired")) return { outcome: "no_subscription" as const };

    let next: SubscriptionDoc;
    if (chosen) {
      const { subscription, plan } = chosen;
      const status = subscriptionStatusOf(subscription);
      if (!before && status === "expired") return { outcome: "no_subscription" as const };
      next = {
        plan,
        interval: intervalOf(subscription.periodStart, subscription.periodEnd),
        status,
        rcSubscriptionId: subscription.id,
        storeSubscriptionId: subscription.storeSubscriptionId,
        store: subscription.store,
        environment: subscription.environment === "production" ? "PRODUCTION" : "SANDBOX",
        periodStart: subscription.periodStart,
        ...(subscription.periodEnd ? { periodEnd: subscription.periodEnd } : {}),
        willRenew: subscription.willRenew && status !== "expired",
        ...(before?.rcSubscriptionId === subscription.id && before.grantedSlotStart ? { grantedSlotStart: before.grantedSlotStart } : {}),
        ...(deps.eventId ? { lastEventId: deps.eventId } : before?.lastEventId ? { lastEventId: before.lastEventId } : {}),
        syncedAt: now,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      };
    } else {
      // RevenueCat no longer lists it (removed, transferred): the plan ended.
      next = { ...before!, status: "expired", willRenew: false, syncedAt: now, updatedAt: now };
    }

    // The month's grant, while the plan is paid (reads first: the transaction writes after).
    const slot = PAID.has(next.status) ? grantSlot(next.periodStart, next.periodEnd ?? null, next.interval, now) : null;
    const entryId = slot ? `grant_${ledgerKey(next.rcSubscriptionId)}_${slot.start.getTime()}` : null;
    const granted = entryId ? await getLedgerEntryTx(tx, accountId, entryId) : null;
    const wallet = entryId && !granted ? await getWalletTx(tx, accountId) : null;

    const event = lifecycleEventFor(profile, next.status, next.plan, now);
    const changed = event ? transition(profile, event, { now, graceDays: pricing.graceDays }) : null;

    if (slot && entryId && !granted) {
      const grant = { credits: pricing.plans[next.plan].credits, featured: pricing.plans[next.plan].featured };
      const { wallet: state, ledger } = grantPlanPeriod(walletStateAt(wallet, now), grant);
      recordWalletOperationTx(tx, accountId, entryId, { before: wallet, state, ledger, entry: { refs: { subscriptionId: next.rcSubscriptionId }, actorUid: "system", at: now }, now, resetsAt: slot.end });
      next = { ...next, grantedSlotStart: slot.start };
    }
    setSubscriptionTx(tx, accountId, next);
    const updated = changed ? profileAfter(profile, changed.patch, pricing, now) : null;
    if (updated) tx.set(proProfileRef(proId), proProfileToFirestore(updated));
    const sameDoc = before !== null && before.status === next.status && before.plan === next.plan && before.periodStart.getTime() === next.periodStart.getTime() && before.willRenew === next.willRenew;
    return {
      outcome: updated || (slot && !granted) || !sameDoc ? ("updated" as const) : ("unchanged" as const),
      event,
      ownerUid: profile.ownerUid,
      quotas: (updated ?? profile).quotas,
      lifecycle: (updated ?? profile).lifecycle,
    };
  });

  if (result.outcome === "no_shop" || result.outcome === "no_subscription") return result.outcome;
  if (result.event) {
    logger.info({ proId, event: result.event.type, lifecycle: result.lifecycle }, "pro subscription transition");
    await audit({ actorUid: "system", actorRole: "system", action: `pro.subscription.${result.event.type}`, target: { type: "pro", id: proId }, automated: true, at: now }).catch((error: unknown) =>
      logger.error({ proId, err: (error as Error).message }, "pro subscription audit failed"),
    );
  }
  // A suspended shop keeps its listings paused by moderation; otherwise the plan's quota applies.
  if (result.lifecycle !== "suspended") {
    try {
      await alignListingsWithQuota(result.ownerUid, result.quotas.activeListings, now);
    } catch (error) {
      // The next sync (renewal, nightly job) runs it again.
      logger.error({ proId, err: (error as Error).message }, "quota alignment failed");
    }
  }
  return result.outcome;
}

/**
 * Fast path of a failed Stripe payment (design §7): an active shop enters grace now, without
 * waiting for RevenueCat to refresh the subscription.
 */
export async function startGrace(proId: string, now = new Date()): Promise<boolean> {
  const pricing = await getPricing();
  const moved = await db().runTransaction(async (tx) => {
    const profile = await getProProfile(proId, tx);
    if (!profile || profile.lifecycle !== "active") return false;
    const { patch } = transition(profile, { type: "billing_issue" }, { now, graceDays: pricing.graceDays });
    tx.set(proProfileRef(proId), proProfileToFirestore(profileAfter(profile, patch, pricing, now)));
    return true;
  });
  if (moved) {
    await audit({ actorUid: "system", actorRole: "system", action: "pro.subscription.billing_issue", target: { type: "pro", id: proId }, automated: true, at: now }).catch((error: unknown) =>
      logger.error({ proId, err: (error as Error).message }, "pro subscription audit failed"),
    );
  }
  return moved;
}
