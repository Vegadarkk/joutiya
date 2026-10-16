import "server-only";
import type { UserRecord } from "firebase-admin/auth";
import type { UserDoc } from "@/lib/db/schemas";
import { findUidByEmail } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { IdentityToolkitError, INVALID_CODE_CODES, INVALID_CREDENTIAL_CODES } from "@/lib/firebase/rest";
import { HttpError, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";

// Small helpers shared by the auth flows: account lookups that never throw for an unknown
// e-mail, Identity Toolkit error mapping, display names for the mails.

export function errorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
}

/** Auth record of this exact e-mail, or null. */
export async function userByEmail(email: string): Promise<UserRecord | null> {
  try {
    return await auth().getUserByEmail(email);
  } catch (error) {
    if (errorCode(error) === "auth/user-not-found") return null;
    throw error;
  }
}

/** Account behind a normalized e-mail (emailIndex first, exact Auth record otherwise). */
export async function accountByEmail(email: string): Promise<UserRecord | null> {
  const uid = await findUidByEmail(email);
  if (uid) {
    try {
      return await auth().getUser(uid);
    } catch (error) {
      if (errorCode(error) !== "auth/user-not-found") throw error;
    }
  }
  return userByEmail(email);
}

export function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export function displayNameFor(profile: Pick<UserDoc, "displayName"> | null, record: Pick<UserRecord, "displayName"> | null, email: string): string {
  return profile?.displayName ?? record?.displayName ?? localPart(email);
}

/** Password sign-in failures, as the API answers them (one code for every bad credential). */
export type SignInFailure = "invalid" | "disabled" | "unavailable";

export function classifySignInError(error: unknown): SignInFailure | null {
  if (!(error instanceof IdentityToolkitError)) return null;
  if (INVALID_CREDENTIAL_CODES.has(error.code)) return "invalid";
  if (error.code === "USER_DISABLED") return "disabled";
  logger.warn({ code: error.code }, "identitytoolkit sign-in refused");
  return "unavailable";
}

/** Runs an action-code call and maps its Identity Toolkit errors (§6 "Inscription par e-mail"). */
export async function withCodeErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof IdentityToolkitError) {
      if (error.code === "EXPIRED_OOB_CODE") throw new HttpError(400, "expired_code");
      if (INVALID_CODE_CODES.has(error.code)) throw new HttpError(400, "invalid_code");
      if (error.code === "USER_DISABLED") throw new HttpError(403, "account_disabled");
      logger.warn({ code: error.code, status: error.status }, "identitytoolkit action code refused");
      // Any other 400 is about the code too (wrong type, malformed): the link is unusable.
      if (error.status === 400) throw new HttpError(400, "invalid_code");
      throw unavailable();
    }
    throw error;
  }
}
