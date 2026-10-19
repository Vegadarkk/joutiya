import "server-only";
import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { EMPTY_WALLET, type LedgerDraft, type WalletState } from "@/lib/payments/wallet";
import { consume } from "@/lib/quota";
import { COLLECTIONS, ledgerEntrySchema, walletSchema, type LedgerEntryDoc, type WalletDoc } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// wallets/{accountId} and its ledger (phase 7 design §3, §5). Server-only; every change goes
// through one transaction of src/lib/payments (wallet, ledger entry and the listing or the order
// together). A missing wallet is an empty one: it is created by its first write.

export interface LedgerRecord extends LedgerEntryDoc {
  id: string;
}

export const walletRef = (accountId: string) => db().collection(COLLECTIONS.wallets).doc(accountId);
export const ledgerRef = (accountId: string, entryId: string) => walletRef(accountId).collection(COLLECTIONS.ledger).doc(entryId);

function walletFromSnapshot(snapshot: DocumentSnapshot): WalletDoc | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = walletSchema.safeParse(timestampsToDates(data));
  // An unreadable wallet must never read as empty (that would unfreeze it): refuse to go on.
  if (!parsed.success) throw new Error(`wallets/${snapshot.id} is invalid`);
  return parsed.data;
}

function ledgerFromSnapshot(snapshot: DocumentSnapshot): LedgerRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = ledgerEntrySchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

/**
 * Spendable state at `now`: the plan's credits and allowance count only until their `resetsAt`
 * (an ended period without a new grant voids them).
 */
export function walletStateAt(wallet: WalletDoc | null, now: Date): WalletState {
  if (!wallet) return EMPTY_WALLET;
  const live = (resetsAt: Date | undefined) => resetsAt === undefined || resetsAt.getTime() > now.getTime();
  return {
    balance: wallet.balance,
    frozen: wallet.frozen,
    planCredits: live(wallet.planCreditsResetsAt) ? wallet.planCredits : 0,
    featuredAllowance: live(wallet.allowances.resetsAt) ? wallet.allowances.featured : 0,
  };
}

export async function getWallet(accountId: string): Promise<WalletDoc | null> {
  const snapshot = await walletRef(accountId).get();
  void consume("firestore.reads", 1);
  return walletFromSnapshot(snapshot);
}

export async function getWalletTx(tx: Transaction, accountId: string): Promise<WalletDoc | null> {
  const snapshot = await tx.get(walletRef(accountId));
  void consume("firestore.reads", 1);
  return walletFromSnapshot(snapshot);
}

export async function getLedgerEntryTx(tx: Transaction, accountId: string, entryId: string): Promise<LedgerRecord | null> {
  const snapshot = await tx.get(ledgerRef(accountId, entryId));
  void consume("firestore.reads", 1);
  return ledgerFromSnapshot(snapshot);
}

/**
 * Writes the wallet after an operation (`state` from src/lib/payments/wallet.ts) and its ledger
 * entry, in the caller's transaction, and returns the wallet written. Reset dates are kept;
 * `create` fails if the entry exists.
 */
export function recordWalletOperationTx(
  tx: Transaction,
  accountId: string,
  entryId: string,
  input: { before: WalletDoc | null; state: WalletState; ledger: LedgerDraft; entry: Omit<LedgerEntryDoc, keyof LedgerDraft>; now: Date },
): WalletDoc {
  const { before, state, ledger, entry, now } = input;
  const wallet: WalletDoc = walletSchema.parse({
    balance: state.balance,
    frozen: state.frozen,
    planCredits: state.planCredits,
    ...(before?.planCreditsResetsAt ? { planCreditsResetsAt: before.planCreditsResetsAt } : {}),
    allowances: { featured: state.featuredAllowance, ...(before?.allowances.resetsAt ? { resetsAt: before.allowances.resetsAt } : {}) },
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  });
  tx.set(walletRef(accountId), datesToTimestamps(wallet));
  tx.create(ledgerRef(accountId, entryId), datesToTimestamps(ledgerEntrySchema.parse({ ...entry, ...ledger })));
  void consume("firestore.writes", 2);
  return wallet;
}

export interface LedgerPage {
  entries: LedgerRecord[];
  /** Id of the last entry, to pass back for the next page. */
  next?: string;
}

/** Ledger of `accountId`, newest first, `limit` entries after the `after` entry id. */
export async function listLedger(accountId: string, limit: number, after?: string): Promise<LedgerPage> {
  const collection = walletRef(accountId).collection(COLLECTIONS.ledger);
  let query = collection.orderBy("at", "desc").limit(limit + 1);
  if (after) {
    const cursor = await collection.doc(after).get();
    void consume("firestore.reads", 1);
    if (!cursor.exists) return { entries: [] };
    query = query.startAfter(cursor);
  }
  const snapshot = await query.get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const records = snapshot.docs.map(ledgerFromSnapshot).filter((record): record is LedgerRecord => record !== null);
  const entries = records.slice(0, limit);
  const last = entries[entries.length - 1];
  return { entries, ...(records.length > limit && last ? { next: last.id } : {}) };
}

/** Test and admin helper: replaces the wallet document (validated). */
export async function setWallet(accountId: string, wallet: WalletDoc): Promise<void> {
  await walletRef(accountId).set(datesToTimestamps(walletSchema.parse(wallet)));
  void consume("firestore.writes", 1);
}
