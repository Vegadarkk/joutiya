import "server-only";
import type { UserRecord } from "firebase-admin/auth";
import { getStaff } from "@/lib/db/repositories/staff";
import { getUser } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims } from "@/lib/firebase/claims";
import { errorCode } from "./accounts";

// What an existing Auth record with a given e-mail is, for the sign-up paths (password and Google):
// a member (users/{uid} exists), a staff account (claims or roster entry, never a users document:
// it signs in on the back office only and must never be turned into a member), or an orphan (no
// document, no staff status: a sign-up whose documents failed, or a purge whose Auth deletion
// failed). An orphan is never adopted: its uid may still key data (favourites, saved searches,
// listings in retention, conversations) once account closure exists, so the next sign-up with its
// e-mail deletes the record and creates a fresh uid. The verification link, or Google's verified
// e-mail, still decides who owns the address.

export type RecordState = "member" | "staff" | "orphan";

/** Staff accounts carry staff claims or a roster entry (revoked members keep the entry, not the claims). */
export async function isStaffRecord(record: UserRecord): Promise<boolean> {
  return isStaff(readClaims(record.customClaims ?? {})) || (await getStaff(record.uid)) !== null;
}

export async function recordState(record: UserRecord): Promise<RecordState> {
  if (await getUser(record.uid)) return "member";
  return (await isStaffRecord(record)) ? "staff" : "orphan";
}

/** Deletes an orphan Auth record so the e-mail is free again; gone already is fine. */
export async function deleteOrphanRecord(uid: string): Promise<void> {
  try {
    await auth().deleteUser(uid);
  } catch (error) {
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }
}
