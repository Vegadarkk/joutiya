import "server-only";
import { UnrecoverableError } from "bullmq";
import { packByProductId } from "@/config/pricing";
import { alert } from "@/lib/alert";
import { getPricing } from "@/lib/config/runtime";
import {
  createBillingEvent,
  createOrderTx,
  findBillingAccountByAppUserId,
  getBillingAccountTx,
  getBillingEvent,
  getOrderTx,
  listBillingEventsByTransactionId,
  orderId,
  setBillingAccountTx,
  setOrderTx,
  updateBillingEvent,
} from "@/lib/db/repositories/billing";
import { getWalletTx, recordWalletOperationTx, walletStateAt } from "@/lib/db/repositories/wallets";
import type { BillingEventDoc, BillingEventSource } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { z } from "@/lib/zod";
import { BillingRetryError, expectedEnvironment } from "./billing-common";
import { enqueueBillingEvent, isBillingQueueEnabled } from "./billing-queue";
import { findPurchase, listCustomerPurchases, RevenueCatApiError, type RevenueCatPurchase } from "./revenuecat-api";
import { syncShopSubscription, type SyncDeps, type SyncOutcome } from "./subscriptions";
import { euPacksOpen, getBillingThresholds } from "./thresholds";
import { creditPurchase, refundPurchase } from "./wallet";

// RevenueCat events of the credit packs (phase 7 design §6). The webhook records each
// authenticated event once (billingEvents/revenuecat_{id}) and hands it to the "billing" queue;
// processing re-reads the customer's purchases from RevenueCat, then writes in one transaction:
// - NON_RENEWING_PURCHASE: orders/{transaction id} (natural key: a replay credits once), the
//   ledger `purchase_*` and the balance;
// - CANCELLATION (for a consumable, always a refund): once RevenueCat shows the purchase as
//   refunded, the ledger `refund_*` debits the whole pack even if spent; a negative balance
//   freezes the wallet and flags the account.
// - a subscription event (a Pro plan billed by Stripe, design §7): the shop's subscription is
//   synced from RevenueCat (src/lib/payments/subscriptions.ts). A CANCELLATION is a subscription's
//   when it carries an expiration or comes from Stripe, a pack refund otherwise.
// Other event types are acknowledged and dropped. A pack paid for an account, a product or in a
// currency we do not know is not credited and alerts (an admin refunds it from the RevenueCat
// dashboard); its refund then ends without a debit.

const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "SUBSCRIPTION_EXTENDED",
  "SUBSCRIPTION_PAUSED",
  "REFUND_REVERSED",
]);
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set(["NON_RENEWING_PURCHASE", "CANCELLATION", ...SUBSCRIPTION_EVENT_TYPES]);

/** Optional fields RevenueCat documents as sometimes absent or null: a malformed one reads as absent. */
const loose = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);

export const revenueCatEnvelopeSchema = z.object({
  event: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    type: z.string().min(1).max(64),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    app_user_id: z.string().min(1).max(1_500),
    product_id: loose(z.string().min(1).max(100)),
    transaction_id: loose(z.string().min(1).max(255)),
    cancel_reason: loose(z.string().min(1).max(64)),
    store: loose(z.string().min(1).max(32)),
    currency: loose(z.string().regex(/^[A-Z]{3}$/)),
    price_in_purchased_currency: loose(z.number().finite().min(-1_000_000).max(1_000_000)),
    country_code: loose(z.string().regex(/^[A-Z]{2}$/)),
    quantity: loose(z.number().int().min(1).max(10)),
    event_timestamp_ms: loose(z.number().int().positive()),
    expiration_at_ms: loose(z.number().int().positive()),
  }),
});

export { BillingRetryError, expectedEnvironment };

export type ReceiveOutcome = "unreadable" | "wrong_environment" | "ignored_type" | "duplicate" | "queued" | ProcessOutcome;

export type ProcessOutcome =
  | "credited"
  | "refunded"
  | "already_refunded"
  | "never_credited"
  | "duplicate"
  | "missing"
  | "missing_transaction"
  | "unknown_customer"
  | "unknown_product"
  | "wrong_currency"
  | SyncOutcome;

/** Outcomes that leave the event `ignored` (nothing written to a wallet). */
const IGNORED: ReadonlySet<ProcessOutcome> = new Set(["never_credited", "missing_transaction", "unknown_customer", "unknown_product", "wrong_currency", "no_shop", "no_subscription"]);


function eventDoc(event: z.infer<typeof revenueCatEnvelopeSchema>["event"], now: Date): BillingEventDoc {
  const price = event.price_in_purchased_currency;
  return {
    source: "revenuecat",
    eventId: event.id,
    type: event.type,
    environment: event.environment,
    appUserId: event.app_user_id,
    ...(event.product_id ? { productId: event.product_id } : {}),
    ...(event.transaction_id ? { transactionId: event.transaction_id } : {}),
    ...(event.cancel_reason ? { cancelReason: event.cancel_reason } : {}),
    ...(event.store ? { store: event.store } : {}),
    ...(event.currency ? { currency: event.currency } : {}),
    ...(typeof price === "number" ? { amountMinor: Math.round(price * 100) } : {}),
    ...(event.country_code ? { countryCode: event.country_code } : {}),
    ...(event.quantity ? { quantity: event.quantity } : {}),
    status: "received",
    attempts: 0,
    ...(event.event_timestamp_ms ? { occurredAt: new Date(event.event_timestamp_ms) } : {}),
    kind: subscriptionEvent(event) ? "subscription" : "pack",
    receivedAt: now,
  };
}

/** A subscription's event (synced), not a pack's: CANCELLATION of a renewing product or from Stripe. */
function subscriptionEvent(event: Pick<z.infer<typeof revenueCatEnvelopeSchema>["event"], "type" | "store" | "expiration_at_ms">): boolean {
  if (SUBSCRIPTION_EVENT_TYPES.has(event.type)) return true;
  return event.type === "CANCELLATION" && (event.expiration_at_ms !== undefined || event.store === "STRIPE");
}

export interface ProcessDeps extends SyncDeps {
  listPurchases?: typeof listCustomerPurchases;
  now?: () => Date;
}

/**
 * An authenticated delivery: recorded once, then queued (or processed inline without Valkey).
 * Unreadable, foreign-environment and unhandled events are acknowledged without a write.
 */
export async function receiveRevenueCatEvent(body: unknown, deps: ProcessDeps = {}): Promise<ReceiveOutcome> {
  const parsed = revenueCatEnvelopeSchema.safeParse(body);
  if (!parsed.success) return "unreadable";
  const { event } = parsed.data;
  if (event.environment !== expectedEnvironment()) return "wrong_environment";
  if (!HANDLED_EVENT_TYPES.has(event.type)) return "ignored_type";
  const now = deps.now?.() ?? new Date();
  if (!(await createBillingEvent(eventDoc(event, now)))) {
    // A retried delivery: done already, or its first processing failed and goes again.
    const known = await getBillingEvent(event.id);
    if (!known || known.status === "processed" || known.status === "ignored") return "duplicate";
  }
  if (isBillingQueueEnabled()) {
    try {
      await enqueueBillingEvent(event.id);
      return "queued";
    } catch (error) {
      // The order key keeps inline processing idempotent; a failure answers 500 and RevenueCat redelivers.
      logger.warn({ webhook: "revenuecat", eventId: event.id, err: (error as Error).message }, "billing queue unavailable: processing inline");
    }
  }
  return processBillingEvent(event.id, deps);
}

async function purchaseOf(event: BillingEventDoc & { transactionId: string; appUserId: string }, deps: ProcessDeps): Promise<RevenueCatPurchase> {
  const list = deps.listPurchases ?? listCustomerPurchases;
  let purchases: RevenueCatPurchase[];
  try {
    purchases = await list(event.appUserId, event.environment === "PRODUCTION" ? "production" : "sandbox");
  } catch (error) {
    if (error instanceof RevenueCatApiError && !error.retryable) throw new UnrecoverableError(error.message);
    throw new BillingRetryError((error as Error).message);
  }
  const purchase = findPurchase(purchases, event.transactionId);
  if (!purchase) throw new BillingRetryError("purchase not visible in RevenueCat yet");
  if (purchase.status !== "owned" && purchase.status !== "refunded") throw new BillingRetryError(`purchase status ${purchase.status}`);
  return purchase;
}

/** Ledger ids keep to the characters the wallet page's cursor accepts. */
function ledgerKey(transactionId: string): string {
  return transactionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
}

async function lost(event: BillingEventDoc, outcome: ProcessOutcome): Promise<ProcessOutcome> {
  logger.error({ webhook: "revenuecat", eventId: event.eventId, type: event.type, outcome }, "billing event not applied");
  await alert({
    severity: "P1",
    // One alert per event: each lost purchase needs its own refund.
    title: `Achat de crédits non crédité (${event.eventId.slice(0, 8)})`,
    body: `Événement RevenueCat ${event.eventId} (${event.type}) : ${outcome}. Vérifier l'achat dans RevenueCat et le rembourser si besoin.`,
  });
  return outcome;
}

async function creditPack(event: BillingEventDoc, deps: ProcessDeps): Promise<ProcessOutcome> {
  const { transactionId, productId, appUserId } = event;
  if (!transactionId || !productId || !appUserId) return lost(event, "missing_transaction");
  const account = await findBillingAccountByAppUserId(appUserId);
  if (!account) return lost(event, "unknown_customer");
  const pack = packByProductId(productId, await getPricing());
  if (!pack) return lost(event, "unknown_product");
  // Paid in another currency than the pack's (an edited purchase link, a second RevenueCat price).
  if (event.currency !== undefined && event.currency !== pack.currency) return lost(event, "wrong_currency");
  const purchase = await purchaseOf({ ...event, transactionId, appUserId }, deps);
  const now = deps.now?.() ?? new Date();
  const quantity = Math.min(Math.max(purchase.quantity, 1), 10);
  const credits = { paid: pack.paid * quantity, bonus: pack.bonus * quantity };
  const taxJurisdiction = pack.currency === "MAD" ? "MA" : "EU";
  const consent = account.lastCheckout?.packId === pack.id ? { version: account.lastCheckout.consentVersion, at: account.lastCheckout.at } : undefined;
  const refunded = purchase.status === "refunded";

  const outcome = await db().runTransaction(async (tx): Promise<ProcessOutcome> => {
    if (await getOrderTx(tx, transactionId)) return "duplicate";
    const before = refunded ? null : await getWalletTx(tx, account.id);
    if (!refunded) {
      const { wallet, ledger } = creditPurchase(walletStateAt(before, now), credits);
      recordWalletOperationTx(tx, account.id, `purchase_${ledgerKey(transactionId)}`, {
        before,
        state: wallet,
        ledger,
        entry: { price: credits.paid, refs: { orderId: orderId(transactionId) }, taxJurisdiction, ...(consent ? { consent } : {}), actorUid: "system", at: now },
        now,
      });
    }
    // Refunded before we saw it: the order is kept for the accounts, nothing is credited.
    createOrderTx(tx, transactionId, {
      kind: "pack",
      accountId: account.id,
      packId: pack.id,
      productId: pack.productId,
      quantity,
      credits,
      currency: event.currency ?? pack.currency,
      ...(event.amountMinor !== undefined && event.amountMinor >= 0 ? { amountMinor: event.amountMinor } : {}),
      status: refunded ? "refunded" : "paid",
      environment: event.environment,
      store: event.store ?? "RC_BILLING",
      taxJurisdiction,
      locationEvidence: event.countryCode ? { countryCode: event.countryCode } : {},
      ...(consent ? { consent } : {}),
      eventId: event.eventId,
      purchasedAt: event.occurredAt ?? now,
      ...(refunded ? { refundedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return refunded ? "already_refunded" : "credited";
  });

  // The grid hides EUR packs past the EU threshold, but a purchase link can be edited.
  if (outcome === "credited" && pack.currency === "EUR" && !euPacksOpen(await getBillingThresholds(now).catch(() => null), now)) {
    await alert({
      severity: "P1",
      title: "Pack en euros vendu au-delà du seuil UE",
      body: `Commande ${orderId(transactionId)} (${pack.id}) : les ventes aux particuliers de l'UE ont atteint le seuil. Rembourser l'achat ou s'inscrire au guichet OSS (docs/tax-runbook.md), et retirer les packs en euros de l'offre RevenueCat.`,
    });
  }
  if (outcome === "credited" && event.amountMinor !== undefined && event.amountMinor !== pack.priceMinor * quantity) {
    // RevenueCat's product price and config/pricing disagree: the credits follow config/pricing.
    logger.warn({ eventId: event.eventId, packId: pack.id }, "pack price differs from RevenueCat's");
    await alert({ severity: "P2", title: `Prix du pack ${pack.id} différent dans RevenueCat`, body: `Événement ${event.eventId} : ${event.amountMinor / 100} ${pack.currency} payés pour ${(pack.priceMinor * quantity) / 100} attendus. Vérifier le prix du produit ${pack.productId} dans RevenueCat et config/pricing.` });
  }
  return outcome;
}

async function refundPack(event: BillingEventDoc, deps: ProcessDeps): Promise<ProcessOutcome> {
  const { transactionId, appUserId } = event;
  if (!transactionId || !appUserId) return lost(event, "missing_transaction");
  const purchase = await purchaseOf({ ...event, transactionId, appUserId }, deps);
  // The refund may not show in RevenueCat yet: the last failed attempt alerts.
  if (purchase.status !== "refunded") throw new BillingRetryError("refund not visible in RevenueCat yet");
  const now = deps.now?.() ?? new Date();

  const result = await db().runTransaction(async (tx) => {
    const order = await getOrderTx(tx, transactionId);
    if (!order) return { outcome: "missing" as const };
    if (order.status === "refunded") return { outcome: "duplicate" as const };
    const before = await getWalletTx(tx, order.accountId);
    const account = await getBillingAccountTx(tx, order.accountId);
    const { wallet, ledger } = refundPurchase(walletStateAt(before, now), order.credits);
    recordWalletOperationTx(tx, order.accountId, `refund_${ledgerKey(transactionId)}`, {
      before,
      state: wallet,
      ledger,
      entry: { price: order.credits.paid, refs: { orderId: orderId(transactionId) }, taxJurisdiction: order.taxJurisdiction, actorUid: "system", at: now },
      now,
    });
    setOrderTx(tx, transactionId, { ...order, status: "refunded", refundEventId: event.eventId, refundedAt: now, updatedAt: now });
    const negative = wallet.balance < 0;
    if (negative && account) setBillingAccountTx(tx, order.accountId, { ...account, flaggedAt: now, updatedAt: now });
    return { outcome: "refunded" as const, negative, accountId: order.accountId, balance: wallet.balance };
  });

  if (result.outcome === "missing") {
    // A purchase never credited (alerted, then refunded by an admin) ends here; one still on its
    // way makes the refund wait for its order.
    const purchases = (await listBillingEventsByTransactionId(transactionId)).filter((known) => known.type === "NON_RENEWING_PURCHASE");
    if (purchases.some((known) => known.status === "ignored")) return "never_credited";
    throw new BillingRetryError("order of the refunded purchase not credited yet");
  }
  if (result.outcome === "refunded" && result.negative) {
    await alert({
      severity: "P2",
      title: `Porte-monnaie négatif après un remboursement (${result.accountId})`,
      body: `Compte ${result.accountId} : solde ${result.balance} crédits, porte-monnaie gelé jusqu'à un nouvel achat ou un ajustement.`,
    });
  }
  return result.outcome;
}

/** A Pro plan's event: the shop behind RevenueCat's customer is synced. */
async function syncSubscriptionEvent(event: BillingEventDoc, deps: ProcessDeps): Promise<ProcessOutcome> {
  const account = event.appUserId ? await findBillingAccountByAppUserId(event.appUserId) : null;
  if (!account) return lost(event, "unknown_customer");
  return syncShopSubscription(account.id, { ...deps, eventId: event.eventId });
}

/** Applies a recorded event; throws BillingRetryError (or an infrastructure error) for a later attempt. */
export async function processBillingEvent(eventId: string, deps: ProcessDeps = {}): Promise<ProcessOutcome> {
  const event = await getBillingEvent(eventId);
  if (!event) return "missing";
  if (event.status === "processed" || event.status === "ignored") return (event.outcome as ProcessOutcome | undefined) ?? "duplicate";
  try {
    const outcome =
      event.type === "NON_RENEWING_PURCHASE" ? await creditPack(event, deps) : event.kind === "subscription" ? await syncSubscriptionEvent(event, deps) : await refundPack(event, deps);
    await updateBillingEvent(eventId, { status: IGNORED.has(outcome) ? "ignored" : "processed", outcome, attempts: event.attempts + 1, processedAt: deps.now?.() ?? new Date() });
    logger.info({ webhook: "revenuecat", eventId, type: event.type, outcome }, "billing event processed");
    return outcome;
  } catch (error) {
    await updateBillingEvent(eventId, { status: "failed", attempts: event.attempts + 1, lastError: (error as Error).message.slice(0, 500) }).catch(() => undefined);
    throw error;
  }
}

/** Last failed attempt of a queued event: an admin checks the purchase or the subscription by hand. */
export async function onBillingEventAbandoned(eventId: string, error: Error, source: BillingEventSource = "revenuecat"): Promise<void> {
  const name = source === "stripe" ? "Stripe" : "RevenueCat";
  logger.error({ webhook: source, eventId, err: error.message }, "billing event abandoned");
  await alert({
    severity: "P1",
    title: `Paiement ${name} non traité (${eventId.slice(0, 12)})`,
    body: `Événement ${eventId} en échec après toutes les tentatives (${error.message.slice(0, 200)}). Vérifier l'achat ou l'abonnement dans ${name} et RevenueCat, puis relancer ou rembourser.`,
  });
}
