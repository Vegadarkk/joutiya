import "server-only";
import { Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { z } from "@/lib/zod";
import { db } from "@/lib/firebase/admin";
import { COLLECTIONS, displayNameSchema } from "../schemas";

// staff/{uid} (§6 "Personnel"): the back-office roster, one document per moderator or admin
// account. The role of record stays in the custom claims; this document carries what the claims
// cannot (who invited, when, revocation) and feeds the /personnel page. Written by the server only.

export const STAFF_COLLECTION = COLLECTIONS.staff;

export const staffRoleSchema = z.enum(["moderator", "admin"]);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const staffDocSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: displayNameSchema,
    role: staffRoleSchema,
    /** uid of the admin who invited, or "script" for the first admin (scripts/create-admin.ts). */
    invitedBy: z.union([z.string().min(1).max(128), z.literal("script")]),
    createdAt: z.date(),
    revokedAt: z.date().optional(),
  })
  .strict();
export type StaffDoc = z.infer<typeof staffDocSchema>;

export interface StaffRecord extends StaffDoc {
  uid: string;
}

export interface UpsertStaffInput {
  uid: string;
  email: string;
  displayName: string;
  role: StaffRole;
  invitedBy: string | "script";
  now?: Date;
}

const staffRef = (uid: string) => db().collection(STAFF_COLLECTION).doc(uid);

function toDate(value: unknown): unknown {
  return value instanceof Timestamp ? value.toDate() : value;
}

function fromSnapshot(snapshot: DocumentSnapshot): StaffRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = staffDocSchema.safeParse({ ...data, createdAt: toDate(data["createdAt"]), revokedAt: toDate(data["revokedAt"]) });
  return parsed.success ? { uid: snapshot.id, ...parsed.data } : null;
}

function toFirestore(doc: StaffDoc): Record<string, unknown> {
  return {
    ...doc,
    createdAt: Timestamp.fromDate(doc.createdAt),
    ...(doc.revokedAt ? { revokedAt: Timestamp.fromDate(doc.revokedAt) } : {}),
  };
}

/**
 * Creates or replaces the roster entry. A re-invitation keeps the original createdAt, takes the
 * new role and inviter, and clears any revocation (the account is active again).
 */
export async function upsertStaff(input: UpsertStaffInput): Promise<StaffRecord> {
  const now = input.now ?? new Date();
  const existing = await getStaff(input.uid);
  const doc = staffDocSchema.parse({
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    invitedBy: input.invitedBy,
    createdAt: existing?.createdAt ?? now,
  });
  await staffRef(input.uid).set(toFirestore(doc));
  return { uid: input.uid, ...doc };
}

/** Marks the member revoked (the claims, sessions and Auth record are handled by the caller). */
export async function revokeStaff(uid: string, now = new Date()): Promise<void> {
  await staffRef(uid).update({ revokedAt: Timestamp.fromDate(now) });
}

export async function getStaff(uid: string): Promise<StaffRecord | null> {
  return fromSnapshot(await staffRef(uid).get());
}

/** Every roster entry, oldest first (revoked members included: the page shows their status). */
export async function listStaff(): Promise<StaffRecord[]> {
  const snapshot = await db().collection(STAFF_COLLECTION).orderBy("createdAt", "asc").get();
  return snapshot.docs.map(fromSnapshot).filter((record): record is StaffRecord => record !== null);
}
