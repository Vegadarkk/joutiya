import "server-only";
import { activateAccount, getUser } from "@/lib/db/repositories/users";
import { isMember, isStaff, setClaims, type Claims } from "@/lib/firebase/claims";

// Activation of a member account (§6 "Inscription par e-mail"): once the e-mail is verified (our
// link, a Google sign-in, a password reset), the account receives role "individual". Idempotent.
// Only accounts created by the sign-up flows (users/{uid} exists) are ever activated here: an Auth
// record without a profile gets no role.

/** True when the account is a member after this call. */
export async function activateMember(uid: string, claims: Claims): Promise<boolean> {
  if (isMember(claims)) return true;
  if (isStaff(claims)) return false;
  const profile = await getUser(uid);
  if (!profile) return false;
  if (profile.activation !== "done" || !profile.badges.emailVerified) await activateAccount(uid);
  await setClaims(uid, { role: "individual" });
  return true;
}
