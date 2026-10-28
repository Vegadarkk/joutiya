import "server-only";
import { UnrecoverableError } from "bullmq";
import { alert } from "@/lib/alert";
import { createBillingEvent, findBillingAccountByAppUserId, findBillingAccountByStripeCustomer, getBillingEvent, updateBillingEvent, type BillingAccountRecord } from "@/lib/db/repositories/billing";
import type { BillingEventDoc } from "@/lib/db/schemas";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { z } from "@/lib/zod";
import { BillingRetryError, expectedEnvironment } from "./billing-common";
import { enqueueBillingEvent, isBillingQueueEnabled } from "./billing-queue";
import { postStripeReceipt, RevenueCatApiError } from "./revenuecat-api";
import { stripeRequest, StripeApiError } from "./stripe-api";
import { startGrace, syncShopSubscription, type SyncDeps, type SyncOutcome } from "./subscriptions";

// Stripe webhook events of the Pro subscriptions (phase 7 design §7). The route checks the
// signature; each event is recorded once (billingEvents/stripe_{id}) and processed by the billing
// queue (inline without Valkey):
// - a new or changed subscription is handed to RevenueCat (POST /v1/receipts) so it tracks it now;
// - a failed payment puts an active shop in grace at once (and stops there);
// - every other event syncs the shop from RevenueCat (src/lib/payments/subscriptions.ts), the source of truth.
// Event payloads are not trusted beyond their ids: the sync re-reads everything.

export const STRIPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);
/** Events after which a past-due subscription opens the grace. */
const GRACE_EVENTS: ReadonlySet<string> = new Set(["invoice.payment_failed", "customer.subscription.updated"]);
const PAST_DUE: ReadonlySet<string> = new Set(["past_due", "unpaid"]);
/** Events after which RevenueCat gets the subscription again (tracked now, not at its next refresh). */
const RECEIPT_EVENTS: ReadonlySet<string> = new Set(["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

const stripeId = z.string().min(1).max(255);
const loose = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);

export const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,100}$/),
  type: z.string().min(1).max(64),
  livemode: z.boolean(),
  created: loose(z.number().int().positive()),
  data: z.object({
    object: z.object({
      id: stripeId,
      object: z.string().min(1).max(64),
      /** An id in webhook payloads (an object only when expanded, never here). */
      customer: loose(stripeId),
      /** Checkout Session: the subscription it created. */
      subscription: loose(stripeId),
      mode: loose(z.string().max(32)),
      metadata: loose(z.record(z.string(), z.string().max(500))),
    }),
  }),
});

export type StripeReceiveOutcome = "unreadable" | "wrong_environment" | "ignored_type" | "duplicate" | "queued" | StripeProcessOutcome;
export type StripeProcessOutcome = SyncOutcome | "missing" | "unknown_customer";
const IGNORED: ReadonlySet<StripeProcessOutcome> = new Set(["unknown_customer", "no_shop", "no_subscription"]);

export interface StripeProcessDeps extends SyncDeps {
  postReceipt?: typeof postStripeReceipt;
  stripe?: typeof stripeRequest;
}

/** A verified delivery: recorded once, then queued (or processed inline without Valkey). */
export async function receiveStripeEvent(body: unknown, deps: StripeProcessDeps = {}): Promise<StripeReceiveOutcome> {
  const parsed = stripeEventSchema.safeParse(body);
  if (!parsed.success) return "unreadable";
  const event = parsed.data;
  // Test-mode events never change a production shop, and the reverse.
  if (event.livemode !== (expectedEnvironment() === "PRODUCTION")) return "wrong_environment";
  const object = event.data.object;
  // Packs are paid on RevenueCat's page: a Checkout Session here is always a plan's.
  if (!STRIPE_EVENT_TYPES.has(event.type) || (object.object === "checkout.session" && object.mode !== "subscription")) return "ignored_type";
  const now = deps.now?.() ?? new Date();
  const subscriptionId = object.object === "subscription" ? object.id : (object.subscription ?? undefined);
  const doc: BillingEventDoc = {
    source: "stripe",
    eventId: event.id,
    type: event.type,
    environment: event.livemode ? "PRODUCTION" : "SANDBOX",
    ...(object.metadata?.app_user_id ? { appUserId: object.metadata.app_user_id.slice(0, 1_500) } : {}),
    ...(object.customer ? { customerId: object.customer } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    objectId: object.id,
    status: "received",
    attempts: 0,
    ...(event.created ? { occurredAt: new Date(event.created * 1_000) } : {}),
    receivedAt: now,
  };
  if (!(await createBillingEvent(doc))) {
    const known = await getBillingEvent(event.id, "stripe");
    if (!known || known.status === "processed" || known.status === "ignored") return "duplicate";
  }
  if (isBillingQueueEnabled()) {
    try {
      await enqueueBillingEvent(event.id, "stripe");
      return "queued";
    } catch (error) {
      logger.warn({ webhook: "stripe", eventId: event.id, err: (error as Error).message }, "billing queue unavailable: processing inline");
    }
  }
  return processStripeEvent(event.id, deps);
}

/** Whether Stripe shows the subscription past due or unpaid (a failed payment not yet fixed). */
export async function pastDue(subscriptionId: string, deps: Pick<StripeProcessDeps, "stripe"> = {}): Promise<boolean> {
  try {
    const subscription = await (deps.stripe ?? stripeRequest)<{ status?: unknown }>("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return typeof subscription.status === "string" && PAST_DUE.has(subscription.status);
  } catch (error) {
    if (error instanceof StripeApiError && !error.retryable) throw new UnrecoverableError(error.message);
    throw new BillingRetryError((error as Error).message);
  }
}

async function accountOf(event: BillingEventDoc): Promise<BillingAccountRecord | null> {
  if (event.customerId) {
    const account = await findBillingAccountByStripeCustomer(event.customerId);
    if (account) return account;
  }
  return event.appUserId ? findBillingAccountByAppUserId(event.appUserId) : null;
}

async function apply(event: BillingEventDoc, deps: StripeProcessDeps): Promise<StripeProcessOutcome> {
  const account = await accountOf(event);
  if (!account) {
    logger.error({ webhook: "stripe", eventId: event.eventId, type: event.type }, "stripe event of an unknown customer");
    await alert({
      severity: "P1",
      title: `Abonnement Stripe sans boutique (${event.eventId.slice(0, 12)})`,
      body: `Événement ${event.eventId} (${event.type}) : aucun compte de facturation pour ce client Stripe. Vérifier le client et l'abonnement dans Stripe.`,
    });
    return "unknown_customer";
  }
  if (RECEIPT_EVENTS.has(event.type) && event.subscriptionId) {
    if (serverEnv().REVENUECAT_STRIPE_PUBLIC_KEY) {
      try {
        await (deps.postReceipt ?? postStripeReceipt)(account.rcAppUserId, event.subscriptionId);
      } catch (error) {
        if (error instanceof RevenueCatApiError && !error.retryable) throw new UnrecoverableError(error.message);
        throw new BillingRetryError((error as Error).message);
      }
    } else {
      // RevenueCat's own Stripe notifications still track it (metadata app_user_id), later.
      logger.warn({ eventId: event.eventId }, "REVENUECAT_STRIPE_PUBLIC_KEY not set: receipt not posted");
    }
  }
  // Stripe knows first that a payment failed: while the subscription is past due the grace opens and
  // nothing is synced (RevenueCat may still list the plan as active and would end the grace at
  // once; its BILLING_ISSUE event brings the subscription doc in line). Read now, not from the
  // payload: a failure delivered after the payment that fixed it opens nothing.
  if (event.subscriptionId && GRACE_EVENTS.has(event.type) && (await pastDue(event.subscriptionId, deps))) {
    if (!account.proId) return "no_shop";
    return (await startGrace(account.proId, deps.now?.() ?? new Date())) ? "updated" : "unchanged";
  }
  return syncShopSubscription(account.id, { ...deps, eventId: event.eventId });
}

/** Applies a recorded Stripe event; throws BillingRetryError (or an infrastructure error) for a later attempt. */
export async function processStripeEvent(eventId: string, deps: StripeProcessDeps = {}): Promise<StripeProcessOutcome> {
  const event = await getBillingEvent(eventId, "stripe");
  if (!event) return "missing";
  if (event.status === "processed" || event.status === "ignored") return (event.outcome as StripeProcessOutcome | undefined) ?? "unchanged";
  try {
    const outcome = await apply(event, deps);
    await updateBillingEvent(eventId, { status: IGNORED.has(outcome) ? "ignored" : "processed", outcome, attempts: event.attempts + 1, processedAt: deps.now?.() ?? new Date() }, "stripe");
    logger.info({ webhook: "stripe", eventId, type: event.type, outcome }, "billing event processed");
    return outcome;
  } catch (error) {
    await updateBillingEvent(eventId, { status: "failed", attempts: event.attempts + 1, lastError: (error as Error).message.slice(0, 500) }, "stripe").catch(() => undefined);
    throw error;
  }
}
