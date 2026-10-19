import "server-only";
import { FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { proProfileSchema, type ProProfileDoc } from "@/lib/pro/profile-schema";
import { COLLECTIONS } from "../schemas";
import { datesToTimestamps, timestampsToDates } from "./timestamps";

// proProfiles/{proId} (architecture §5, phase 7 design §3-4). Server-only; every write goes
// through a transaction of src/lib/pro/service.ts so the profile, the user document, the
// listings and the audit entry change together.

export interface ProProfileRecord extends ProProfileDoc {
  proId: string;
}

export const proProfileRef = (proId: string) => db().collection(COLLECTIONS.proProfiles).doc(proId);

export function proProfileFromSnapshot(snapshot: DocumentSnapshot): ProProfileRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = proProfileSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { proId: snapshot.id, ...parsed.data } : null;
}

/** Validated document ready to write (Dates -> Timestamps, undefined fields dropped). */
export function proProfileToFirestore(doc: ProProfileDoc): Record<string, unknown> {
  return datesToTimestamps(proProfileSchema.parse(doc)) as Record<string, unknown>;
}

export async function getProProfile(proId: string, tx?: Transaction): Promise<ProProfileRecord | null> {
  const snapshot = tx ? await tx.get(proProfileRef(proId)) : await proProfileRef(proId).get();
  void consume("firestore.reads", 1);
  return proProfileFromSnapshot(snapshot);
}

/** The shop owned by `uid` (one per account at the MVP), or null. */
export async function findProProfileByOwner(uid: string): Promise<ProProfileRecord | null> {
  const query = await db().collection(COLLECTIONS.proProfiles).where("ownerUid", "==", uid).limit(1).get();
  void consume("firestore.reads", Math.max(1, query.size));
  const first = query.docs[0];
  return first ? proProfileFromSnapshot(first) : null;
}

/** Applications by KYBC status, oldest submission first (index kybc.status, kybc.submittedAt). */
export async function listProApplications(status: ProProfileDoc["kybc"]["status"], limit: number): Promise<ProProfileRecord[]> {
  const query = await db().collection(COLLECTIONS.proProfiles).where("kybc.status", "==", status).orderBy("kybc.submittedAt", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, query.size));
  return query.docs.map(proProfileFromSnapshot).filter((record): record is ProProfileRecord => record !== null);
}

/** Rejected profiles whose retention ended (purgeAt, single-field range), oldest first. */
export async function listProProfilesPastPurge(now: Date, limit: number): Promise<ProProfileRecord[]> {
  const query = await db().collection(COLLECTIONS.proProfiles).where("purgeAt", "<=", Timestamp.fromDate(now)).orderBy("purgeAt", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, query.size));
  return query.docs.map(proProfileFromSnapshot).filter((record): record is ProProfileRecord => record !== null);
}

/** Verified profiles whose post-commit effects (claims, retag) are still pending, oldest first. */
export async function listProEffectsPending(now: Date, limit: number): Promise<ProProfileRecord[]> {
  const query = await db().collection(COLLECTIONS.proProfiles).where("effectsPendingSince", "<=", Timestamp.fromDate(now)).orderBy("effectsPendingSince", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, query.size));
  return query.docs.map(proProfileFromSnapshot).filter((record): record is ProProfileRecord => record !== null);
}

/**
 * Deletes a rejected profile whose retention ended and unlinks its owner (`users.proId`) in one
 * transaction, re-checking both: a resubmission since the query (lifecycle no longer rejected, no
 * purgeAt) or an owner linked elsewhere leaves everything in place. Returns the deleted profile,
 * or null when nothing was purged.
 */
export async function purgeProProfile(proId: string, now: Date): Promise<ProProfileRecord | null> {
  const ref = proProfileRef(proId);
  const purged = await db().runTransaction(async (tx) => {
    const current = proProfileFromSnapshot(await tx.get(ref));
    if (!current || current.lifecycle !== "rejected" || !current.purgeAt || current.purgeAt.getTime() > now.getTime()) return null;
    const userRef = db().collection(COLLECTIONS.users).doc(current.ownerUid);
    const user = await tx.get(userRef);
    tx.delete(ref);
    if (user.exists && user.get("proId") === proId) tx.update(userRef, { proId: FieldValue.delete(), updatedAt: Timestamp.fromDate(now) });
    return current;
  });
  void consume("firestore.reads", 2);
  if (purged) void consume("firestore.writes", 2);
  return purged;
}
