import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { accessIdentity } from "@/lib/auth/guards";
import { getUserPrivate } from "@/lib/db/repositories/users";
import type { StaffRole } from "@/lib/db/repositories/staff";
import { isMember, isStaff } from "@/lib/firebase/claims";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { SESSION_COOKIE } from "@/lib/security/cookies";
import { hostKind } from "@/lib/security/origin";

// Session of the current render (layouts, server components). Pages are not an authorization
// barrier for data: every API route re-checks (§6); here the session only decides what to show
// and where to redirect. Back-office pages still guard themselves (requirePageStaff): a layout
// guard alone is skipped by client-side navigations, which render the page on its own.

/** Revocation is checked like /api/auth/me does: a signed-out or reset account never renders as signed in. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value, { checkRevoked: true });
}

/** A member (individual or pro) with an activated account, on the public host; null otherwise. */
export async function currentMember(): Promise<SessionUser | null> {
  if (hostKind(await headers()) !== "public") return null;
  const user = await currentUser();
  return user && isMember(user.claims) ? user : null;
}

/**
 * users/{uid}/private/account, read once per render: the private layout's session summary and the
 * account layout's consent gate share the read (React cache is scoped to the request).
 */
export const renderUserPrivate = cache(getUserPrivate);

export interface PageStaff extends SessionUser {
  role: StaffRole;
  /** E-mail asserted by Cloudflare Access (second factor), lower-cased. */
  accessEmail: string;
}

/**
 * The staff session of a back-office render, bound to the request's Cloudflare Access identity
 * (what requireStaff checks for the API: admin host, Access identity, revocation, staff role and
 * matching e-mail); null when any of these fails.
 */
export async function currentStaff(): Promise<PageStaff | null> {
  const requestHeaders = await headers();
  if (hostKind(requestHeaders) !== "admin") return null;
  // accessIdentity works on a Request: only its headers matter here.
  const access = await accessIdentity(new Request("http://admin.invalid/", { headers: requestHeaders }));
  if (!access) return null;
  const store = await cookies();
  const user = await verifySession(store.get(SESSION_COOKIE)?.value, { checkRevoked: true });
  if (!user || !isStaff(user.claims) || !user.claims.role) return null;
  if ((user.email ?? "").toLowerCase() !== access.email) return null;
  return { ...user, role: user.claims.role as StaffRole, accessEmail: access.email };
}

/**
 * Guard of every protected back-office page, called by the page itself. Off the admin host: 404.
 * Anonymous, revoked or not the Access identity: /connexion. Role not in `roles`: 404 (the page
 * does not exist for that role, like the API's 403 without a hint).
 */
export async function requirePageStaff(roles?: readonly StaffRole[]): Promise<PageStaff> {
  if (hostKind(await headers()) !== "admin") notFound();
  const staff = await currentStaff();
  if (!staff) redirect("/connexion");
  if (roles && !roles.includes(staff.role)) notFound();
  return staff;
}
