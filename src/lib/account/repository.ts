import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { notFound } from "@/lib/http/errors";
import { PRO_ID_PATTERN } from "@/lib/pro/profile-schema";
import { consume } from "@/lib/quota";
import { closureDates, statusAfterClosure, type ClosureBillingState } from "./rules";

// Firestore side of an account closure (phase 5 D26, lot L7): the closure dates and the status in
// one transaction, the billing documents the Pro refusal reads, and the favorites and saved
// searches the closure deletes. The nightly purge of closed accounts is in ./purge.ts.

const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);
const privateRef = (uid: string) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);

/**
 * Billing documents of phase 7 (design §3, architecture §5 "Facturation et porte-monnaie"):
 * `{accountId}` is the uid, or `pro_{proId}` for a shop. Read only here; nothing on this branch
 * writes them yet, so they are absent and read as nothing to block.
 */
const BILLING = { subscriptions: "subscriptions", wallets: "wallets" } as const;

export interface ClosureAccount {
  displayName: string;
  publicId: string;
  locale: string;
  status: string;
  /** The account's shop (application or verified Pro), validated as a document id. */
  proId: string | null;
  email: string | null;
  closedAt: Date | null;
}

const dateOf = (value: unknown): Date | null => (value instanceof Timestamp ? value.toDate() : value instanceof Date ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const proIdOf = (value: unknown): string | null => (typeof value === "string" && PRO_ID_PATTERN.test(value) ? value : null);

/** What the closure needs of users/{uid} and its private document; 404 when either is missing. */
export async function readClosureAccount(uid: string): Promise<ClosureAccount> {
  const [user, account] = await db().getAll(userRef(uid), privateRef(uid));
  void consume("firestore.reads", 2);
  if (!user?.exists || !account?.exists) throw notFound();
  return {
    displayName: text(user.get("displayName")) ?? "",
    publicId: text(user.get("publicId")) ?? "",
    locale: text(user.get("locale")) ?? "fr",
    status: text(user.get("status")) ?? "active",
    proId: proIdOf(user.get("proId")),
    email: text(account.get("email")),
    closedAt: dateOf(account.get("closedAt")),
  };
}

/** The Pro profile, subscriptions and wallets of the account and of its shop, as stored (one getAll). */
export async function readBillingState(uid: string, proId: string | null): Promise<ClosureBillingState> {
  const col = (name: string) => db().collection(name);
  const accounts = [uid, ...(proId ? [`pro_${proId}`] : [])];
  const refs = [...accounts.map((id) => col(BILLING.subscriptions).doc(id)), ...accounts.map((id) => col(BILLING.wallets).doc(id)), ...(proId ? [col(COLLECTIONS.proProfiles).doc(proId)] : [])];
  const snapshots = await db().getAll(...refs);
  void consume("firestore.reads", refs.length);
  const subscriptions = snapshots.slice(0, accounts.length).filter((snapshot) => snapshot.exists).map((snapshot) => ({ status: snapshot.get("status") as unknown, willRenew: snapshot.get("willRenew") as unknown }));
  const wallets = snapshots.slice(accounts.length, 2 * accounts.length).filter((snapshot) => snapshot.exists).map((snapshot) => ({ balance: snapshot.get("balance") as unknown }));
  const profile = proId ? snapshots[2 * accounts.length] : undefined;
  // Only the owner's shop counts: an editor seat (V1.1) does not pay for it.
  const owned = profile?.exists && profile.get("ownerUid") === uid;
  return {
    proProfile: owned ? { planSource: String(profile.get("planSource") ?? ""), lifecycle: String(profile.get("lifecycle") ?? "") } : null,
    subscriptions,
    wallets,
  };
}

export interface ClosureMark {
  closedAt: Date;
  purgeAt: Date;
  identityPurgeAt: Date;
  /** A previous attempt had closed it (its dates are kept). */
  already: boolean;
}

/**
 * Closure dates on users/{uid}/private/account and the status on users/{uid}, in one transaction.
 * Idempotent: an account already closed keeps its dates (a retry after a failure half-way never
 * moves them); its status is set again if needed. A banned account stays banned. Nothing else of
 * the private document changes (legal holds, strikes, e-mail: the purge's).
 */
export async function markAccountClosed(uid: string, now: Date): Promise<ClosureMark> {
  return db().runTransaction(async (tx) => {
    const [user, account] = await tx.getAll(userRef(uid), privateRef(uid));
    void consume("firestore.reads", 2);
    if (!user?.exists || !account?.exists) throw notFound();
    const stored = { closedAt: dateOf(account.get("closedAt")), purgeAt: dateOf(account.get("purgeAt")), identityPurgeAt: dateOf(account.get("identityPurgeAt")) };
    const fresh = closureDates(now);
    const already = stored.closedAt !== null;
    const dates = already ? { closedAt: stored.closedAt ?? fresh.closedAt, purgeAt: stored.purgeAt ?? fresh.purgeAt, identityPurgeAt: stored.identityPurgeAt ?? fresh.identityPurgeAt } : fresh;
    let writes = 0;
    if (!already || !stored.purgeAt || !stored.identityPurgeAt) {
      tx.update(privateRef(uid), { closedAt: Timestamp.fromDate(dates.closedAt), purgeAt: Timestamp.fromDate(dates.purgeAt), identityPurgeAt: Timestamp.fromDate(dates.identityPurgeAt) });
      writes += 1;
    }
    const status = statusAfterClosure(String(user.get("status") ?? ""));
    if (user.get("status") !== status) {
      tx.update(userRef(uid), { status, updatedAt: Timestamp.fromDate(now) });
      writes += 1;
    }
    void consume("firestore.writes", writes);
    return { ...dates, already };
  });
}

/** Pages of a closure's deletions (a page of document ids, then one batch). */
const DELETE_PAGE = 200;
/** Favorites deleted at most (more are left to the purge of the account, users/{uid} subcollections). */
export const CLOSURE_FAVORITES_MAX = 2000;

/** Deletes the favorites of `uid` (ids only read); returns the listing ids, for the favorite counters. */
export async function deleteAllFavorites(uid: string, max = CLOSURE_FAVORITES_MAX): Promise<string[]> {
  const col = userRef(uid).collection(COLLECTIONS.favorites);
  const deleted: string[] = [];
  while (deleted.length < max) {
    const snapshot = await col.select().limit(Math.min(DELETE_PAGE, max - deleted.length)).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    if (snapshot.empty) break;
    const batch = db().batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    void consume("firestore.deletes", snapshot.size);
    deleted.push(...snapshot.docs.map((doc) => doc.id));
    if (snapshot.size < DELETE_PAGE) break;
  }
  return deleted;
}

/** Deletes the saved searches of `uid` (their alerts stop with them); returns how many. */
export async function deleteAllSavedSearches(uid: string): Promise<number> {
  const col = userRef(uid).collection(COLLECTIONS.savedSearches);
  let count = 0;
  for (;;) {
    const snapshot = await col.select().limit(DELETE_PAGE).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    if (snapshot.empty) break;
    const batch = db().batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    void consume("firestore.deletes", snapshot.size);
    count += snapshot.size;
    if (snapshot.size < DELETE_PAGE) break;
  }
  return count;
}
