import "server-only";
import { Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { COLLECTIONS, closedIdentitySchema } from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { auth, db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { accountPurgeVerdict, identityPurgeable } from "./rules";

// Nightly purge of closed accounts (retention-purge step, phase 5 D26 lot L7; AF §5 "Purges sans
// TTL", §7 retention table). One collection-group query on `private` by purgeAt (its own
// single-field override in firestore.indexes.json) finds both documents a closed account leaves:
// - users/{uid}/private/account at purgeAt (closure + 1 year): the Auth user, the account documents
//   (e-mail, phone, pseudonym, identifiers) and the emailIndex entry go; what must outlive them until
//   identityPurgeAt is written to users/{uid}/private/identity first (rules.ts accountPurgeVerdict);
// - users/{uid}/private/identity at its purgeAt (the account's identityPurgeAt, closure + 5 years):
//   it goes, with the emailIndex entry a ban kept.
// A legal hold keeps either document (the next nights look again). Never throws for one account:
// the step counts it failed and goes on.

const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);
const privateRef = (uid: string) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);
const identityRef = (uid: string) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userIdentityDoc);
const emailRef = (hash: string) => db().collection(COLLECTIONS.emailIndex).doc(hash);

export type ClosedDocKind = "account" | "identity";

export interface ClosedDoc {
  uid: string;
  kind: ClosedDocKind;
}

export interface ClosedDocPage {
  docs: ClosedDoc[];
  /** Documents read (Spark charges one for an empty result). */
  read: number;
  /** Cursor of the next page, when this one was full. */
  next?: QueryDocumentSnapshot;
}

/** users/{uid}/private/{account|identity} documents past purgeAt, oldest first. */
export async function listClosedPastPurge(now: Date, limit: number, after?: QueryDocumentSnapshot): Promise<ClosedDocPage> {
  let query = db().collectionGroup(COLLECTIONS.userPrivate).where("purgeAt", "<=", Timestamp.fromDate(now)).orderBy("purgeAt", "asc");
  if (after) query = query.startAfter(after);
  const snapshot = await query.limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const docs: ClosedDoc[] = [];
  for (const doc of snapshot.docs) {
    const uid = doc.ref.parent.parent?.id;
    // Only users/{uid}/private/{account|identity}: any other path is not ours to purge.
    if (!uid || doc.ref.parent.parent?.parent.id !== COLLECTIONS.users) continue;
    if (doc.id === COLLECTIONS.userPrivateDoc) docs.push({ uid, kind: "account" });
    else if (doc.id === COLLECTIONS.userIdentityDoc) docs.push({ uid, kind: "identity" });
  }
  return { docs, read: Math.max(1, snapshot.size), ...(snapshot.size === limit ? { next: snapshot.docs[snapshot.size - 1] } : {}) };
}

export type PurgeOutcome =
  | { kind: "skip" }
  | { kind: "held" }
  /** `deletes`: Firestore documents deleted (budget); `identityKept`: the identity document was written. */
  | { kind: "purged"; deletes: number; identityKept: boolean };

const errorCode = (error: unknown): string => (typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "");

/** Deletes the Auth user; one already gone is fine (a retry, or an account deleted by hand). */
async function deleteAuthUser(uid: string): Promise<void> {
  try {
    await auth().deleteUser(uid);
  } catch (error) {
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }
}

/**
 * A closed account past purgeAt: its verdict from the stored documents, then the Auth user (first:
 * a failed transaction leaves documents the next night retries, never an orphan Auth record the
 * purge can no longer find), then one transaction that re-checks the verdict and deletes users/{uid},
 * its private account document and its emailIndex entry (unless a ban keeps it), after writing
 * users/{uid}/private/identity when the verdict keeps one.
 */
export async function purgeClosedAccount(uid: string, now: Date): Promise<PurgeOutcome> {
  const [user, account] = await db().getAll(userRef(uid), privateRef(uid));
  void consume("firestore.reads", 2);
  const data = account?.data();
  if (!data) return { kind: "skip" };
  const status = user?.exists ? String(user.get("status") ?? "") : null;
  const verdict = accountPurgeVerdict(timestampsToDates(data), status, now);
  if (verdict.kind !== "purge") return verdict;

  await deleteAuthUser(uid);

  return db().runTransaction(async (tx) => {
    const [userSnap, accountSnap] = await tx.getAll(userRef(uid), privateRef(uid));
    void consume("firestore.reads", 2);
    const current = accountSnap?.data();
    if (!current) return { kind: "skip" } as const;
    const plain = timestampsToDates(current);
    const again = accountPurgeVerdict(plain, userSnap?.exists ? String(userSnap.get("status") ?? "") : null, now);
    if (again.kind !== "purge") return again;
    const hash = typeof plain.emailNormHash === "string" && plain.emailNormHash.length >= 16 ? plain.emailNormHash : null;
    // Reads before writes: the index entry goes only when it is this account's.
    const index = hash && !again.keepEmailBlock ? await tx.get(emailRef(hash)) : null;
    if (index) void consume("firestore.reads", 1);
    let deletes = 0;
    if (again.keepIdentity) {
      const identity = closedIdentitySchema.parse({
        closedAt: plain.closedAt,
        purgeAt: plain.identityPurgeAt,
        ...(typeof plain.legalName === "string" && plain.legalName ? { legalName: plain.legalName } : {}),
        ...(again.keepEmailBlock && hash ? { emailNormHash: hash } : {}),
        banned: again.keepEmailBlock,
        legalHold: [],
      });
      tx.set(identityRef(uid), datesToTimestamps(identity));
      void consume("firestore.writes", 1);
    }
    if (index?.exists && String(index.get("uid")) === uid) {
      tx.delete(index.ref);
      deletes += 1;
    }
    tx.delete(privateRef(uid));
    deletes += 1;
    if (userSnap?.exists) {
      tx.delete(userRef(uid));
      deletes += 1;
    }
    void consume("firestore.deletes", deletes);
    return { kind: "purged", deletes, identityKept: again.keepIdentity } as const;
  });
}

/** users/{uid}/private/identity past its purgeAt and not held: deleted, with the emailIndex entry a ban kept. */
export async function purgeClosedIdentity(uid: string, now: Date): Promise<PurgeOutcome> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(identityRef(uid));
    void consume("firestore.reads", 1);
    const data = snapshot.data();
    if (!data) return { kind: "skip" } as const;
    const plain = timestampsToDates(data);
    if (!identityPurgeable(plain, now)) return Array.isArray(plain.legalHold) && plain.legalHold.length > 0 ? ({ kind: "held" } as const) : ({ kind: "skip" } as const);
    const hash = typeof plain.emailNormHash === "string" && plain.emailNormHash.length >= 16 ? plain.emailNormHash : null;
    const index = hash ? await tx.get(emailRef(hash)) : null;
    if (index) void consume("firestore.reads", 1);
    let deletes = 1;
    if (index?.exists && String(index.get("uid")) === uid) {
      tx.delete(index.ref);
      deletes += 1;
    }
    tx.delete(snapshot.ref);
    void consume("firestore.deletes", deletes);
    return { kind: "purged", deletes, identityKept: false } as const;
  });
}
