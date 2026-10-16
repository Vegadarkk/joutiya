import "server-only";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";

// One verified number per account (§5 users/{uid}/private.phoneE164). The lookup is a collection
// group query on `private`: production needs the COLLECTION_GROUP single-field index on
// phoneE164 (firestore.indexes.json fieldOverrides); the emulator needs nothing.

/** uid of the account that verified `e164`, or null. */
export async function findUidByVerifiedPhone(e164: string): Promise<string | null> {
  const snapshot = await db().collectionGroup(COLLECTIONS.userPrivate).where("phoneE164", "==", e164).limit(1).get();
  const document = snapshot.docs[0];
  if (!document) return null;
  // users/{uid}/private/account: the uid is the grandparent document.
  return document.ref.parent.parent?.id ?? null;
}

/** True when another account than `uid` already verified `e164`. */
export async function isPhoneVerifiedByOther(e164: string, uid: string): Promise<boolean> {
  const owner = await findUidByVerifiedPhone(e164);
  return owner !== null && owner !== uid;
}
