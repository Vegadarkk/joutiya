import "server-only";
import { serverEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";

// Identity Toolkit REST v1 (phase-2/research/firebase.md §1): password sign-in, custom-token
// exchange and action codes, called by the server only. The key identifies the project (never an
// authorization); FIREBASE_SERVER_API_KEY is a key without referrer restriction limited to this API.
// The emulator serves the same API under http://<host>/identitytoolkit.googleapis.com/v1.

export class IdentityToolkitError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`identitytoolkit: ${code}`);
    this.name = "IdentityToolkitError";
  }
}

export interface SignInResult {
  localId: string;
  idToken: string;
  email?: string;
  refreshToken?: string;
}

interface ToolkitErrorBody {
  error?: { code?: number; message?: string };
}

function endpoint(method: string): string {
  const env = serverEnv();
  const key = env.FIREBASE_SERVER_API_KEY ?? env.FIREBASE_API_KEY ?? "";
  const base = env.FIREBASE_AUTH_EMULATOR_HOST
    ? `http://${env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`
    : "https://identitytoolkit.googleapis.com/v1";
  return `${base}/accounts:${method}?key=${encodeURIComponent(key)}`;
}

async function call<T>(method: string, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const env = serverEnv();
  if (!env.FIREBASE_API_KEY && !env.FIREBASE_SERVER_API_KEY && !env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new HttpError(503, "unavailable", "Firebase Auth is not configured");
  }
  let response: Response;
  try {
    response = await fetchImpl(endpoint(method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Matches the browser key's referrer restriction when the server key is the same key.
        Referer: `${new URL(env.SITE_URL).origin}/`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    logger.warn({ method, err: (error as Error).name }, "identitytoolkit unreachable");
    throw new HttpError(503, "unavailable", "Firebase Auth unreachable");
  }
  if (response.ok) return (await response.json()) as T;
  let code = `HTTP_${response.status}`;
  try {
    const payload = (await response.json()) as ToolkitErrorBody;
    const message = payload.error?.message;
    if (typeof message === "string" && message) code = message.split(" : ")[0] ?? message;
  } catch {
    // Non-JSON error body: keep the HTTP code.
  }
  throw new IdentityToolkitError(code, response.status);
}

/** Password sign-in. Unknown e-mail, wrong password and enumeration-protected answers are one code. */
export async function signInWithPassword(email: string, password: string, fetchImpl?: typeof fetch): Promise<SignInResult> {
  return call<SignInResult>("signInWithPassword", { email, password, returnSecureToken: true }, fetchImpl);
}

/** Exchanges a custom token minted by the Admin SDK for an ID token (then a session cookie). */
export async function signInWithCustomToken(token: string, fetchImpl?: typeof fetch): Promise<SignInResult> {
  return call<SignInResult>("signInWithCustomToken", { token, returnSecureToken: true }, fetchImpl);
}

export interface OobResult {
  email?: string;
  localId?: string;
  emailVerified?: boolean;
  requestType?: string;
}

/** Applies a VERIFY_EMAIL code (accounts:update with oobCode). */
export async function applyEmailVerificationCode(oobCode: string, fetchImpl?: typeof fetch): Promise<OobResult> {
  return call<OobResult>("update", { oobCode }, fetchImpl);
}

/** Checks a PASSWORD_RESET code without consuming it. */
export async function verifyPasswordResetCode(oobCode: string, fetchImpl?: typeof fetch): Promise<OobResult> {
  return call<OobResult>("resetPassword", { oobCode }, fetchImpl);
}

/** Consumes a PASSWORD_RESET code; Firebase revokes the refresh tokens and marks the e-mail verified. */
export async function confirmPasswordReset(oobCode: string, newPassword: string, fetchImpl?: typeof fetch): Promise<OobResult> {
  return call<OobResult>("resetPassword", { oobCode, newPassword }, fetchImpl);
}

/** Codes a wrong password or unknown account produce; all answered as invalid_credentials. */
export const INVALID_CREDENTIAL_CODES = new Set(["INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND", "INVALID_PASSWORD", "INVALID_EMAIL", "MISSING_PASSWORD"]);
export const INVALID_CODE_CODES = new Set(["INVALID_OOB_CODE", "EXPIRED_OOB_CODE"]);
