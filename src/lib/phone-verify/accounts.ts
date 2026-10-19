import "server-only";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";

// One verified number per account (§5 users/{uid}/private.phoneE164), and one account per number:
// proof of possession wins. Whoever sends the code from the phone gets the number, and the account
// that held it before loses it in the same transaction, so a phished verification is never
// permanent (the real owner re-verifies and takes the number back). The holder lookup is a
// collection group query on `private`: production needs the COLLECTION_GROUP single-field index on
// phoneE164 (firestore.indexes.json fieldOverrides); the emulator needs nothing.

export interface ClaimResult {
  /** Account that held the number until now, or null (first verification, or the same account). */
  previousUid: string | null;
}

/**
 * Marks `e164` verified on `uid` and removes it from any other account that held it (number,
 * verification date and badge), in one transaction. Counted against the Spark quotas: the holder
 * query on every attempt (a contended transaction runs again), the writes once committed.
 */
export async function claimVerifiedPhone(uid: string, e164: string, now = new Date()): Promise<ClaimResult> {
  let moved = 0;
  const result = await db().runTransaction(async (tx) => {
    const claimed = await claimVerifiedPhoneIn(tx, uid, e164, now);
    moved = claimed.moved;
    return { previousUid: claimed.previousUid };
  });
  // The caller's two documents, and two per account that lost the number.
  void consume("firestore.writes", 2 + 2 * moved);
  return result;
}

/**
 * The same claim inside a caller's transaction (a moderator's phone check writes the Pro profile
 * and the number together). The caller counts the writes once committed: 2 + 2 * `moved`.
 */
export async function claimVerifiedPhoneIn(tx: Transaction, uid: string, e164: string, now: Date): Promise<ClaimResult & { moved: number }> {
  const firestore = db();
  const userRef = (id: string) => firestore.collection(COLLECTIONS.users).doc(id);
  const privateRef = (id: string) => userRef(id).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);
  const holders = await tx.get(firestore.collectionGroup(COLLECTIONS.userPrivate).where("phoneE164", "==", e164));
  // A query is billed one read per document returned, at least one.
  void consume("firestore.reads", Math.max(1, holders.size));
  let moved = 0;
  let previousUid: string | null = null;
  for (const holder of holders.docs) {
    // users/{uid}/private/account: the uid is the grandparent document.
    const holderUid = holder.ref.parent.parent?.id;
    if (!holderUid || holderUid === uid) continue;
    previousUid ??= holderUid;
    tx.update(holder.ref, { phoneE164: FieldValue.delete(), phoneVerifiedAt: FieldValue.delete() });
    tx.update(userRef(holderUid), { "badges.phoneVerified": false, updatedAt: now });
    moved += 1;
  }
  tx.update(privateRef(uid), { phoneE164: e164, phoneVerifiedAt: now });
  tx.update(userRef(uid), { "badges.phoneVerified": true, updatedAt: now });
  return { previousUid, moved };
}
