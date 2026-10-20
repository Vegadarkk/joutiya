import "server-only";
import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import {
  billingAccountSchema,
  billingEventSchema,
  COLLECTIONS,
  orderSchema,
  type BillingAccountDoc,
  type BillingEventDoc,
  type OrderDoc,
} from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// billingAccounts, orders and billingEvents (phase 7 design §3, §6). Server-only. The order and
// its ledger credit are written in one transaction of src/lib/payments/revenuecat-events.ts; an
// event document is created once per RevenueCat event id (duplicate deliveries find it).

/** gRPC status code of a `create` on an existing document. */
const ALREADY_EXISTS = 6;

export interface BillingAccountRecord extends BillingAccountDoc {
  id: string;
}

export const billingAccountRef = (accountId: string) => db().collection(COLLECTIONS.billingAccounts).doc(accountId);
export const orderRef = (transactionId: string) => db().collection(COLLECTIONS.orders).doc(orderId(transactionId));
export const billingEventRef = (eventId: string) => db().collection(COLLECTIONS.billingEvents).doc(`revenuecat_${eventId}`);

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

export async function getBillingEvent(eventId: string): Promise<BillingEventDoc | null> {
  const snapshot = await billingEventRef(eventId).get();
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
    await billingEventRef(event.eventId).create(datesToTimestamps(billingEventSchema.parse(event)));
    void consume("firestore.writes", 1);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === ALREADY_EXISTS) return false;
    throw error;
  }
}

export async function updateBillingEvent(eventId: string, patch: Partial<Pick<BillingEventDoc, "status" | "outcome" | "attempts" | "lastError" | "processedAt">>): Promise<void> {
  await billingEventRef(eventId).update(datesToTimestamps(patch));
  void consume("firestore.writes", 1);
}
