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

/** Current claims of an account, from the Auth user record. */
export async function getClaims(uid: string): Promise<Claims> {
  const record = await auth().getUser(uid);
  return readClaims(record.customClaims ?? {});
}
