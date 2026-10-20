import "server-only";
import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import {
  billingAccountSchema,
  billingEventSchema,
  COLLECTIONS,
  orderSchema,
  subscriptionSchema,
  type BillingAccountDoc,
  type BillingEventDoc,
  type BillingEventSource,
  type OrderDoc,
  type SubscriptionDoc,
} from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// billingAccounts, orders, subscriptions and billingEvents (phase 7 design §3, §6, §7).
// Server-only. The order and its ledger credit are written in one transaction of
// src/lib/payments/revenuecat-events.ts, the subscription with the Pro lifecycle in
// src/lib/payments/subscriptions.ts; an event document is created once per webhook event id
// (duplicate deliveries find it).

/** gRPC status code of a `create` on an existing document. */
const ALREADY_EXISTS = 6;

export interface BillingAccountRecord extends BillingAccountDoc {
  id: string;
}

export const billingAccountRef = (accountId: string) => db().collection(COLLECTIONS.billingAccounts).doc(accountId);
export const orderRef = (transactionId: string) => db().collection(COLLECTIONS.orders).doc(orderId(transactionId));
export const billingEventRef = (eventId: string, source: BillingEventSource = "revenuecat") => db().collection(COLLECTIONS.billingEvents).doc(`${source}_${eventId}`);
export const subscriptionRef = (accountId: string) => db().collection(COLLECTIONS.subscriptions).doc(accountId);

/** Firestore ids cannot hold "/": a store transaction id is kept as is otherwise (natural key). */
export function orderId(transactionId: string): string {
  return transactionId.replaceAll("/", "_");
}

function parse<T>(snapshot: DocumentSnapshot, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, what: string): T | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = schema.safeParse(timestampsToDates(data));
  // Money documents: an unreadable one stops the operation instead of reading as absent.
  if (!parsed.success) throw new Error(`${what}/${snapshot.id} is invalid`);
  return parsed.data;
}

export async function getBillingAccountTx(tx: Transaction, accountId: string): Promise<BillingAccountDoc | null> {
  const snapshot = await tx.get(billingAccountRef(accountId));
  void consume("firestore.reads", 1);
  return parse(snapshot, billingAccountSchema, COLLECTIONS.billingAccounts);
}

export function setBillingAccountTx(tx: Transaction, accountId: string, account: BillingAccountDoc): void {
  tx.set(billingAccountRef(accountId), datesToTimestamps(billingAccountSchema.parse(account)));
  void consume("firestore.writes", 1);
}

/** The account RevenueCat knows as `rcAppUserId` (an equality on one field: no composite index). */
export async function findBillingAccountByAppUserId(rcAppUserId: string): Promise<BillingAccountRecord | null> {
  const snapshot = await db().collection(COLLECTIONS.billingAccounts).where("rcAppUserId", "==", rcAppUserId).limit(2).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.size !== 1) return null;
  const doc = snapshot.docs[0]!;
  const account = parse(doc, billingAccountSchema, COLLECTIONS.billingAccounts);
  return account ? { id: doc.id, ...account } : null;
}

/** The account whose Stripe Customer is `stripeCustomerId` (an equality on one field). */
export async function findBillingAccountByStripeCustomer(stripeCustomerId: string): Promise<BillingAccountRecord | null> {
  const snapshot = await db().collection(COLLECTIONS.billingAccounts).where("stripeCustomerId", "==", stripeCustomerId).limit(2).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  if (snapshot.size !== 1) return null;
  const doc = snapshot.docs[0]!;
  const account = parse(doc, billingAccountSchema, COLLECTIONS.billingAccounts);
  return account ? { id: doc.id, ...account } : null;
}

export async function getBillingAccount(accountId: string): Promise<BillingAccountDoc | null> {
  const snapshot = await billingAccountRef(accountId).get();
  void consume("firestore.reads", 1);
  return parse(snapshot, billingAccountSchema, COLLECTIONS.billingAccounts);
}

export async function getSubscription(accountId: string): Promise<SubscriptionDoc | null> {
  const snapshot = await subscriptionRef(accountId).get();
  void consume("firestore.reads", 1);
  return parse(snapshot, subscriptionSchema, COLLECTIONS.subscriptions);
}

export async function getSubscriptionTx(tx: Transaction, accountId: string): Promise<SubscriptionDoc | null> {
  const snapshot = await tx.get(subscriptionRef(accountId));
  void consume("firestore.reads", 1);
  return parse(snapshot, subscriptionSchema, COLLECTIONS.subscriptions);
}

/** Statuses of a plan RevenueCat may still renew, end or move: the nightly re-sync reads them. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "cancelled", "grace", "billing_issue"] as const;

/**
 * Subscriptions not expired, the least recently synced first (index status, syncedAt): every sync
 * rewrites `syncedAt`, so successive runs go round all of them. An unreadable one is left out.
 */
export async function listLiveSubscriptions(limit: number): Promise<{ accountId: string; subscription: SubscriptionDoc }[]> {
  const query = await db().collection(COLLECTIONS.subscriptions).where("status", "in", [...LIVE_SUBSCRIPTION_STATUSES]).orderBy("syncedAt", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, query.size));
  return query.docs.flatMap((snapshot) => {
    const parsed = subscriptionSchema.safeParse(timestampsToDates(snapshot.data()));
    return parsed.success ? [{ accountId: snapshot.id, subscription: parsed.data }] : [];
  });
}

export function setSubscriptionTx(tx: Transaction, accountId: string, subscription: SubscriptionDoc): void {
  tx.set(subscriptionRef(accountId), datesToTimestamps(subscriptionSchema.parse(subscription)));
  void consume("firestore.writes", 1);
}

export async function getOrderTx(tx: Transaction, transactionId: string): Promise<OrderDoc | null> {
  const snapshot = await tx.get(orderRef(transactionId));
  void consume("firestore.reads", 1);
  return parse(snapshot, orderSchema, COLLECTIONS.orders);
}

export async function getOrder(transactionId: string): Promise<OrderDoc | null> {
  const snapshot = await orderRef(transactionId).get();
  void consume("firestore.reads", 1);
  return parse(snapshot, orderSchema, COLLECTIONS.orders);
}

/** `create`: a concurrent second credit of the same transaction fails and its transaction retries. */
export function createOrderTx(tx: Transaction, transactionId: string, order: OrderDoc): void {
  tx.create(orderRef(transactionId), datesToTimestamps(orderSchema.parse(order)));
  void consume("firestore.writes", 1);
}

export function setOrderTx(tx: Transaction, transactionId: string, order: OrderDoc): void {
  tx.set(orderRef(transactionId), datesToTimestamps(orderSchema.parse(order)));
  void consume("firestore.writes", 1);
}

export async function getBillingEvent(eventId: string, source: BillingEventSource = "revenuecat"): Promise<BillingEventDoc | null> {
  const snapshot = await billingEventRef(eventId, source).get();
  void consume("firestore.reads", 1);
  return parse(snapshot, billingEventSchema, COLLECTIONS.billingEvents);
}

/** Events of one store transaction (an equality on one field: no composite index). */
export async function listBillingEventsByTransactionId(transactionId: string): Promise<BillingEventDoc[]> {
  const snapshot = await db().collection(COLLECTIONS.billingEvents).where("transactionId", "==", transactionId).limit(20).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.flatMap((doc) => parse(doc, billingEventSchema, COLLECTIONS.billingEvents) ?? []);
}

/** Records a delivery; false when the event id is already known (a duplicate delivery). */
export async function createBillingEvent(event: BillingEventDoc): Promise<boolean> {
  try {
    await billingEventRef(event.eventId, event.source).create(datesToTimestamps(billingEventSchema.parse(event)));
    void consume("firestore.writes", 1);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === ALREADY_EXISTS) return false;
    throw error;
  }
}

export async function updateBillingEvent(
  eventId: string,
  patch: Partial<Pick<BillingEventDoc, "status" | "outcome" | "attempts" | "lastError" | "processedAt">>,
  source: BillingEventSource = "revenuecat",
): Promise<void> {
  await billingEventRef(eventId, source).update(datesToTimestamps(patch));
  void consume("firestore.writes", 1);
}
