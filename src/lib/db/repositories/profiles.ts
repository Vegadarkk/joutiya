import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, publicIdSchema, userSchema, type UserDoc } from "../schemas";
import { timestampsToDates } from "./timestamps";

// Public profile lookups (§5: no uid in a public URL, /profil/{publicId}). Read side of the users
// collection for the listing pages; the users repository keeps the account writes.

export interface UserRecord extends UserDoc {
  uid: string;
}

/** Account behind a public id (single-field index on `publicId`), or null. */
export async function findUserByPublicId(publicId: string): Promise<UserRecord | null> {
  if (!publicIdSchema.safeParse(publicId).success) return null;
  const snapshot = await db().collection(COLLECTIONS.users).where("publicId", "==", publicId).limit(1).get();
  void consume("firestore.reads", 1);
  const doc = snapshot.docs[0];
  if (!doc) return null;
  const parsed = userSchema.safeParse(timestampsToDates(doc.data()));
  return parsed.success ? { uid: doc.id, ...parsed.data } : null;
}

/** users/{uid} with Dates (the users repository returns raw Timestamps). */
export async function getUserRecord(uid: string): Promise<UserRecord | null> {
  const snapshot = await db().collection(COLLECTIONS.users).doc(uid).get();
  void consume("firestore.reads", 1);
  const data = snapshot.data();
  if (!data) return null;
  const parsed = userSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { uid: snapshot.id, ...parsed.data } : null;
}

/** A page of users/{uid} in document id order, after `afterUid` (jobs that visit every account). */
export async function listUserRecordsAfter(afterUid: string | null, limit: number): Promise<{ users: UserRecord[]; read: number; lastUid: string | null }> {
  let query = db().collection(COLLECTIONS.users).orderBy(FieldPath.documentId()).limit(limit);
  if (afterUid) query = query.startAfter(afterUid);
  const snapshot = await query.get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const users: UserRecord[] = [];
  for (const doc of snapshot.docs) {
    const parsed = userSchema.safeParse(timestampsToDates(doc.data()));
    if (parsed.success) users.push({ uid: doc.id, ...parsed.data });
  }
  return { users, read: snapshot.size, lastUid: snapshot.docs.at(-1)?.id ?? null };
}
