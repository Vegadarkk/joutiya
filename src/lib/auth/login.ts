import "server-only";
import { RATE_LIMITS } from "@/config/rate-limits";
import { loginSchema, type LoginResponse } from "@/lib/contracts/auth";
import { emailNormHash } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims } from "@/lib/firebase/claims";
import { signInWithPassword } from "@/lib/firebase/rest";
import { createSessionForUid, createSessionFromServerSignIn, type MintedSession } from "@/lib/firebase/session";
import { HttpError, forbidden, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { consumeLimit, consumedPoints, enforceLimit, resetLimit } from "@/lib/rate-limit/limiter";
import { classifySignInError } from "./accounts";
import { activateMember } from "./activation";
import { anonymous, beginAnonymous, checkTurnstile, finish, hasPass, respond } from "./anonymous";
import { signedIn } from "./respond";
import { sessionSummary } from "./summary";

// Login by e-mail (§6 "Connexion par e-mail"): the server checks the password through the Identity
// Toolkit REST API, applies the account + IP lockout (5 failures / 15 min), Turnstile from the 3rd
// failure (20 per hour on the account: mandatory), then mints the session cookie.

export const LOCK_SECONDS = RATE_LIMITS["login.fail.accountIp"].blockDuration;
export const TURNSTILE_AFTER_FAILURES = 3;
export const ACCOUNT_FAILURE_LIMIT = RATE_LIMITS["login.fail.account"].points;

export interface LoginKeys {
  account: string;
  accountIp: string;
}

export function loginKeys(email: string, ipBucket: string): LoginKeys {
  const account = emailNormHash(email);
  return { account, accountIp: `${account}:${ipBucket}` };
}

/** 429 `account_locked` once this account + IP exhausted its failures. */
export async function assertNotLocked(keys: LoginKeys): Promise<{ failures: number; accountFailures: number }> {
  const [failures, accountFailures] = await Promise.all([consumedPoints("login.fail.accountIp", keys.accountIp), consumedPoints("login.fail.account", keys.account)]);
  const result = { failures: failures ?? 0, accountFailures: accountFailures ?? 0 };
  if (result.failures >= RATE_LIMITS["login.fail.accountIp"].points) {
    throw new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(LOCK_SECONDS) } });
  }
  return result;
}

/** Counts a failed password check for the account and the account + IP. */
export async function recordFailure(keys: LoginKeys): Promise<void> {
  await Promise.all([consumeLimit("login.fail.accountIp", keys.accountIp), consumeLimit("login.fail.account", keys.account)]);
}

/** Password check through Identity Toolkit; a bad credential counts as a failure (401), a disabled account is 403. */
export async function checkPassword(email: string, password: string, keys: LoginKeys): Promise<{ localId: string; idToken: string }> {
  try {
    return await signInWithPassword(email, password);
  } catch (error) {
    const failure = classifySignInError(error);
    if (failure === null) throw error;
    if (failure === "invalid") {
      await recordFailure(keys);
      throw new HttpError(401, "invalid_credentials");
    }
    if (failure === "disabled") throw new HttpError(403, "account_disabled");
    throw unavailable("Firebase Auth refused the sign-in");
  }
}

async function login(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, loginSchema);
  await enforceLimit("login.ip", flow.identity.ipBucket);
  const keys = loginKeys(input.email, flow.identity.ipBucket);
  const { failures, accountFailures } = await assertNotLocked(keys);

  const turnstileNeeded = (failures >= TURNSTILE_AFTER_FAILURES || accountFailures >= ACCOUNT_FAILURE_LIMIT) && !hasPass(flow, request);
  if (turnstileNeeded) {
    if (!input.turnstileToken) return respond<LoginResponse>(flow, { status: "turnstile_required" });
    await checkTurnstile(flow, input.turnstileToken, "login");
  }

  const result = await checkPassword(input.email, input.password, keys);
  const record = await auth().getUser(result.localId);
  if (record.disabled) throw new HttpError(403, "account_disabled");
  const claims = readClaims(record.customClaims ?? {});
  // Staff accounts only exist on the back office (§6 "Personnel"): no public session for them.
  if (isStaff(claims)) throw forbidden("staff accounts sign in on the back office");
  if (!record.emailVerified) return respond<LoginResponse>(flow, { status: "verification_required" });

  let minted: MintedSession;
  if (claims.role) {
    minted = await createSessionFromServerSignIn(result.idToken);
  } else {
    // Verified e-mail without a role: a pending account whose activation did not complete.
    if (!(await activateMember(record.uid, claims))) return respond<LoginResponse>(flow, { status: "verification_required" });
    minted = await createSessionForUid(record.uid);
  }
  await resetLimit("login.fail.accountIp", keys.accountIp);
  await logConnection({ uid: record.uid, event: "login", ip: flow.identity.ip, userAgent: flow.userAgent });
  const body: LoginResponse = { status: "signed_in", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

export const handleLogin = anonymous(login);
