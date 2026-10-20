import "server-only";
import { alert } from "@/lib/alert";
import {
  createBillingEvent,
  findBillingAccountByStripeCustomer,
  getOrder,
  getSubscription,
  listBillingEventsByTransactionId,
  listRecentPackCheckouts,
  listStuckBillingEvents,
} from "@/lib/db/repositories/billing";
import type { BillingEventDoc } from "@/lib/db/schemas";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { expectedEnvironment } from "./billing-common";
import { isRevenueCatApiConfigured, listCustomerPurchases, postStripeReceipt, productStoreIdentifier, type RevenueCatPurchase } from "./revenuecat-api";
import { processBillingEvent, type ProcessOutcome } from "./revenuecat-events";
import { isStripeConfigured, stripeRequest } from "./stripe-api";
import { processStripeEvent, receiveStripeEvent, STRIPE_EVENT_TYPES, type StripeReceiveOutcome } from "./stripe-events";
import { syncShopSubscription } from "./subscriptions";

// Nightly billing reconciliation (phase 7 design §8), after the pro-plans job: what the webhooks
// and the billing queue missed is replayed through the same handlers (natural keys keep each
// replay idempotent), and every repair or unsolved case is alerted.
// 1. Events still `received` or `failed` 3 hours after their arrival (the queue's ~2 h of retries
//    are over, or the job was lost) are processed again, each up to SWEEP_MAX_ATTEMPTS attempts.
// 2. Stripe events not delivered to the endpoint (`delivery_success=false`, the 30 days Stripe
//    keeps) are recorded and processed as if they had arrived.
// 3. Stripe subscriptions not canceled whose shop has no running plan here are handed to
//    RevenueCat again and synced. A paid invoice belongs to such a subscription, and the month's
//    grant of a known one is the pro-plans job's.
// 4. RevenueCat purchases of the accounts that opened a pack checkout in the last 7 days: a pack
//    owned without its order, or refunded with its order still paid, gets a recorded event of its
//    own (`reconcile_...`) processed by the pack handlers, which re-read the purchase.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const SWEEP_AFTER_MS = 3 * HOUR_MS;
export const SWEEP_MAX_ATTEMPTS = 20;
const SWEEP_LIMIT = 100;
const STRIPE_EVENTS_DAYS = 30;
const STRIPE_PAGES = 10;
const PACK_DAYS = 7;
const PACK_ACCOUNTS = 200;
const MAX_PROBLEMS = 15;
/** Stripe subscription statuses that give the shop its plan (or its grace). */
const STRIPE_RUNNING: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);
/** Receive outcomes that repair nothing: known already, or not ours. */
const NOTHING_TO_REPAIR: ReadonlySet<StripeReceiveOutcome> = new Set(["duplicate", "ignored_type", "wrong_environment", "unreadable"]);
const PACK_REPAIRED: ReadonlySet<ProcessOutcome> = new Set(["credited", "refunded", "already_refunded"]);

export interface ReconcileRun {
  /** Stuck events processed again. */
  swept: number;
  /** Undelivered Stripe events replayed. */
  stripeEvents: number;
  /** Shops whose Stripe subscription had no running plan here, synced. */
  subscriptions: number;
  /** Packs credited or refunded from RevenueCat's purchases. */
  packs: number;
  failed: number;
  /** French lines for the alert, at most MAX_PROBLEMS. */
  problems: string[];
}

export interface ReconcileDeps {
  stripe?: typeof stripeRequest;
  listPurchases?: typeof listCustomerPurchases;
  storeIdentifier?: typeof productStoreIdentifier;
}

const short = (error: unknown) => (error as Error).message.slice(0, 160);

function problem(run: ReconcileRun, line: string): void {
  run.failed += 1;
  if (run.problems.length < MAX_PROBLEMS) run.problems.push(line);
}

async function sweepStuckEvents(run: ReconcileRun, now: Date): Promise<void> {
  const stuck = await listStuckBillingEvents(new Date(now.getTime() - STRIPE_EVENTS_DAYS * DAY_MS), new Date(now.getTime() - SWEEP_AFTER_MS), SWEEP_LIMIT);
  for (const event of stuck) {
    // Given up: the alert of its last attempt asked for a check by hand.
    if (event.attempts >= SWEEP_MAX_ATTEMPTS) continue;
    try {
      if (event.source === "stripe") await processStripeEvent(event.eventId);
      else await processBillingEvent(event.eventId);
      run.swept += 1;
    } catch (error) {
      problem(run, `Événement ${event.source} ${event.eventId} toujours en échec (${event.attempts + 1} essais) : ${short(error)}`);
    }
  }
}

async function replayStripeEvents(run: ReconcileRun, now: Date, deps: ReconcileDeps): Promise<void> {
  const stripe = deps.stripe ?? stripeRequest;
  let startingAfter: string | undefined;
  for (let page = 0; page < STRIPE_PAGES; page += 1) {
    const list = await stripe<{ data?: { id?: unknown }[]; has_more?: boolean }>("GET", "/v1/events", {
      delivery_success: false,
      types: [...STRIPE_EVENT_TYPES],
      created: { gte: Math.floor(now.getTime() / 1_000) - STRIPE_EVENTS_DAYS * 86_400 },
      limit: 100,
      starting_after: startingAfter,
    });
    for (const event of list.data ?? []) {
      try {
        if (!NOTHING_TO_REPAIR.has(await receiveStripeEvent(event))) run.stripeEvents += 1;
      } catch (error) {
        problem(run, `Événement Stripe ${String(event.id).slice(0, 40)} non rejoué : ${short(error)}`);
      }
    }
    const last = list.data?.at(-1)?.id;
    if (!list.has_more || typeof last !== "string") return;
    startingAfter = last;
  }
}

async function checkStripeSubscriptions(run: ReconcileRun, deps: ReconcileDeps): Promise<void> {
  const stripe = deps.stripe ?? stripeRequest;
  let startingAfter: string | undefined;
  for (let page = 0; page < STRIPE_PAGES; page += 1) {
    // Without a status, Stripe lists every subscription not canceled.
    const list = await stripe<{ data?: { id: string; status?: string; customer?: unknown }[]; has_more?: boolean }>("GET", "/v1/subscriptions", { limit: 100, starting_after: startingAfter });
    for (const subscription of list.data ?? []) {
      if (!subscription.status || !STRIPE_RUNNING.has(subscription.status) || typeof subscription.customer !== "string") continue;
      try {
        const account = await findBillingAccountByStripeCustomer(subscription.customer);
        if (!account) {
          problem(run, `Abonnement Stripe ${subscription.id} (${subscription.status}) : aucun compte de facturation pour ${subscription.customer}.`);
          continue;
        }
        const local = await getSubscription(account.id);
        if (local && local.status !== "expired") continue;
        if (serverEnv().REVENUECAT_STRIPE_PUBLIC_KEY) await postStripeReceipt(account.rcAppUserId, subscription.id);
        if ((await syncShopSubscription(account.id)) === "updated") run.subscriptions += 1;
        else problem(run, `Abonnement Stripe ${subscription.id} (${subscription.status}) : RevenueCat ne donne encore aucune offre à ${account.id}.`);
      } catch (error) {
        problem(run, `Abonnement Stripe ${subscription.id} non vérifié : ${short(error)}`);
      }
    }
    const last = list.data?.at(-1)?.id;
    if (!list.has_more || !last) return;
    startingAfter = last;
  }
}

/** The recorded event that replays `purchase` (a credit or a refund), or null when one exists already. */
async function packEvent(purchase: RevenueCatPurchase & { storePurchaseIdentifier: string }, type: "NON_RENEWING_PURCHASE" | "CANCELLATION", appUserId: string, now: Date, deps: ReconcileDeps): Promise<BillingEventDoc | null> {
  // An event of this purchase already recorded is the queue's or the sweep's, or was alerted.
  const known = await listBillingEventsByTransactionId(purchase.storePurchaseIdentifier);
  if (known.some((event) => event.type === type)) return null;
  const productId = purchase.productId ? await (deps.storeIdentifier ?? productStoreIdentifier)(purchase.productId) : undefined;
  return {
    source: "revenuecat",
    eventId: `reconcile_${purchase.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}_${type === "CANCELLATION" ? "refund" : "purchase"}`,
    type,
    environment: expectedEnvironment(),
    appUserId,
    ...(productId ? { productId } : {}),
    transactionId: purchase.storePurchaseIdentifier,
    store: (purchase.store ?? "rc_billing").toUpperCase().slice(0, 32),
    ...(purchase.country ? { countryCode: purchase.country } : {}),
    quantity: Math.min(Math.max(purchase.quantity, 1), 10),
    kind: "pack",
    status: "received",
    attempts: 0,
    ...(purchase.purchasedAt ? { occurredAt: purchase.purchasedAt } : {}),
    receivedAt: now,
  };
}

async function checkRecentPacks(run: ReconcileRun, now: Date, deps: ReconcileDeps): Promise<void> {
  const environment = expectedEnvironment() === "PRODUCTION" ? "production" : "sandbox";
  for (const account of await listRecentPackCheckouts(new Date(now.getTime() - PACK_DAYS * DAY_MS), PACK_ACCOUNTS)) {
    let purchases: RevenueCatPurchase[];
    try {
      purchases = await (deps.listPurchases ?? listCustomerPurchases)(account.rcAppUserId, environment);
    } catch (error) {
      problem(run, `Achats RevenueCat du compte ${account.id} illisibles : ${short(error)}`);
      continue;
    }
    for (const purchase of purchases) {
      const transactionId = purchase.storePurchaseIdentifier;
      if (!transactionId || (purchase.status !== "owned" && purchase.status !== "refunded")) continue;
      try {
        const order = await getOrder(transactionId);
        const type = purchase.status === "owned" ? (order ? null : "NON_RENEWING_PURCHASE") : order?.status === "paid" ? "CANCELLATION" : null;
        if (!type) continue;
        const event = await packEvent({ ...purchase, storePurchaseIdentifier: transactionId }, type, account.rcAppUserId, now, deps);
        if (!event) continue;
        await createBillingEvent(event);
        const outcome = await processBillingEvent(event.eventId);
        if (PACK_REPAIRED.has(outcome)) run.packs += 1;
        else problem(run, `Achat ${transactionId} du compte ${account.id} : ${outcome} (vérifier dans RevenueCat).`);
      } catch (error) {
        problem(run, `Achat ${transactionId} du compte ${account.id} non rapproché : ${short(error)}`);
      }
    }
  }
}

export async function reconcileBilling(now = new Date(), deps: ReconcileDeps = {}): Promise<ReconcileRun> {
  const run: ReconcileRun = { swept: 0, stripeEvents: 0, subscriptions: 0, packs: 0, failed: 0, problems: [] };
  const steps: [string, boolean, () => Promise<void>][] = [
    ["sweep", true, () => sweepStuckEvents(run, now)],
    ["stripe events", isStripeConfigured(), () => replayStripeEvents(run, now, deps)],
    ["stripe subscriptions", isStripeConfigured() && isRevenueCatApiConfigured(), () => checkStripeSubscriptions(run, deps)],
    ["packs", isRevenueCatApiConfigured(), () => checkRecentPacks(run, now, deps)],
  ];
  for (const [name, enabled, step] of steps) {
    if (!enabled) continue;
    try {
      await step();
    } catch (error) {
      problem(run, `Étape « ${name} » interrompue : ${short(error)}`);
    }
  }

  const repaired = run.swept + run.stripeEvents + run.subscriptions + run.packs;
  if (repaired > 0) {
    await alert({
      severity: "P2",
      title: `Paiements rattrapés cette nuit (${repaired})`,
      body: `Événements relancés : ${run.swept}. Événements Stripe non livrés rejoués : ${run.stripeEvents}. Abonnements resynchronisés : ${run.subscriptions}. Packs crédités ou remboursés : ${run.packs}. Vérifier pourquoi les webhooks ne sont pas arrivés.`,
    });
  }
  if (run.failed > 0) {
    await alert({
      severity: "P1",
      title: `Rapprochement des paiements : ${run.failed} point(s) à vérifier`,
      body: run.problems.join("\n"),
    });
  }
  logger.info({ swept: run.swept, stripeEvents: run.stripeEvents, subscriptions: run.subscriptions, packs: run.packs, failed: run.failed }, "billing reconciliation done");
  return run;
}
