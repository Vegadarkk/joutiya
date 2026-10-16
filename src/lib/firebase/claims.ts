import "server-only";
import { z } from "@/lib/zod";
import { auth } from "./admin";

// Custom claims (§6): set only by the Admin SDK, 1 000 bytes max. Every change revokes the refresh
// tokens so the old claims cannot be renewed; existing session cookies fail checkRevoked.

export const ROLES = ["individual", "pro", "moderator", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: readonly Role[] = ["moderator", "admin"];
export const MEMBER_ROLES: readonly Role[] = ["individual", "pro"];

export const CLAIMS_VERSION = 2;

export const claimsSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    proId: z.string().min(1).max(64).optional(),
    proRole: z.enum(["owner", "editor"]).optional(),
    st: z.literal("suspended").optional(),
    v: z.literal(CLAIMS_VERSION).optional(),
  })
  .strict();

export type Claims = z.infer<typeof claimsSchema>;

/** Claims of a decoded token: unknown or malformed values read as "no claim" (so, no right). */
export function readClaims(token: Record<string, unknown>): Claims {
  const picked = { role: token["role"], proId: token["proId"], proRole: token["proRole"], st: token["st"], v: token["v"] };
  const parsed = claimsSchema.safeParse(Object.fromEntries(Object.entries(picked).filter(([, value]) => value !== undefined)));
  return parsed.success ? parsed.data : {};
}

export function isStaff(claims: Claims): boolean {
  return claims.role !== undefined && STAFF_ROLES.includes(claims.role);
}

export function isMember(claims: Claims): boolean {
  return claims.role !== undefined && MEMBER_ROLES.includes(claims.role);
}

/**
 * Replaces the user's claims and revokes the refresh tokens (§6 "Révocation"). `null` clears every
 * claim: the account can then do nothing until a role is set again.
 */
export async function setClaims(uid: string, claims: Claims | null): Promise<void> {
  const value = claims === null ? null : claimsSchema.parse({ ...claims, v: CLAIMS_VERSION });
  await auth().setCustomUserClaims(uid, value);
  await auth().revokeRefreshTokens(uid);
}

export type ClaimsPatch = { [K in keyof Omit<Claims, "v">]?: Claims[K] | null };

/** `current` with `patch` applied: a null value removes the claim, an absent key keeps it. */
export function mergeClaims(current: Claims, patch: ClaimsPatch): Claims {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return claimsSchema.parse({ ...next, v: CLAIMS_VERSION });
}

/**
 * Read-merge-write of the claims (one helper for every partial change: the Pro grant of phase 7,
 * the `st` suspension of phase 5), then the same revocation as `setClaims`. Firebase Auth has no
 * compare-and-set: two concurrent callers on one account still race, so callers serialise their
 * own changes (the Pro review transaction, the sanction transaction) before calling this.
 */
export async function updateClaims(uid: string, patch: ClaimsPatch): Promise<Claims> {
  const next = mergeClaims(await getClaims(uid), patch);
  await setClaims(uid, next);
  return next;
}

/** Current claims of an account, from the Auth user record. */
export async function getClaims(uid: string): Promise<Claims> {
  const record = await auth().getUser(uid);
  return readClaims(record.customClaims ?? {});
}
