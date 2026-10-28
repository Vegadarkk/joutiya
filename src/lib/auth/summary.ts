import "server-only";
import type { SessionSummary } from "@/lib/contracts/auth";
import { getUser, getUserPrivate } from "@/lib/db/repositories/users";
import type { SessionUser } from "@/lib/firebase/session";

// What the browser learns about its own session (§6): claims from the cookie, profile from
// users/{uid}, providers from the private document. Nothing of anyone else.

/** `readPrivate`: a render passes its per-request cached reader (current-user.ts renderUserPrivate). */
export async function sessionSummary(user: SessionUser, readPrivate: typeof getUserPrivate = getUserPrivate): Promise<SessionSummary> {
  const [profile, account] = await Promise.all([getUser(user.uid), readPrivate(user.uid)]);
  return {
    uid: user.uid,
    email: user.email ?? account?.email ?? null,
    emailVerified: user.emailVerified || (profile?.badges.emailVerified ?? false),
    role: user.claims.role ?? null,
    suspended: user.claims.st === "suspended",
    displayName: profile?.displayName ?? null,
    publicId: profile?.publicId ?? null,
    phoneVerified: profile?.badges.phoneVerified ?? false,
    locale: profile?.locale ?? null,
    providers: account?.providers ?? [],
  };
}
