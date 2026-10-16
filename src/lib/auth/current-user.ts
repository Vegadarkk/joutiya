import "server-only";
import { cookies, headers } from "next/headers";
import { isMember, isStaff } from "@/lib/firebase/claims";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { SESSION_COOKIE } from "@/lib/security/cookies";
import { hostKind } from "@/lib/security/origin";

// Session of the current render (layouts, server components). Pages are not an authorization
// barrier for data: every API route re-checks (§6); here the session only decides what to show
// and where to redirect.

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/** A member (individual or pro) with an activated account, on the public host; null otherwise. */
export async function currentMember(): Promise<SessionUser | null> {
  if (hostKind(await headers()) !== "public") return null;
  const user = await currentUser();
  return user && isMember(user.claims) ? user : null;
}

/** A staff session on the admin host (the layout also checks the Access identity). */
export async function currentStaff(): Promise<SessionUser | null> {
  if (hostKind(await headers()) !== "admin") return null;
  const store = await cookies();
  const user = await verifySession(store.get(SESSION_COOKIE)?.value, { checkRevoked: true });
  return user && isStaff(user.claims) ? user : null;
}
