import "server-only";
import { cguAccepted, LEGAL_VERSIONS } from "@/config/legal-versions";
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
    // No private document (an account being created): nothing to acknowledge.
    cguUpdate: account && !cguAccepted(account.consents?.cgu?.version) ? { version: LEGAL_VERSIONS.cgu.version, effective: LEGAL_VERSIONS.cgu.effective } : null,
  };
}
