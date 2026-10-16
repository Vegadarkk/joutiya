import "server-only";
import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
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
