import "server-only";
import { loginSchema, type LoginResponse } from "@/lib/contracts/auth";
import { emailNormHash } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims } from "@/lib/firebase/claims";
import { signInWithPassword } from "@/lib/firebase/rest";
import { createSessionForUid, createSessionFromServerSignIn, type MintedSession } from "@/lib/firebase/session";
import { HttpError, forbidden, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { assertLimit, blockLimit, consumeLimit, consumedPoints, limitState, rateLimitDefinition, resetLimit } from "@/lib/rate-limit/limiter";
import { classifySignInError } from "./accounts";
import { activateMember } from "./activation";
import { anonymous, beginAnonymous, checkTurnstile, finish, hasPass, respond } from "./anonymous";
import { signedIn } from "./respond";
import { sessionSummary } from "./summary";

// Login by e-mail (§6 "Connexion par e-mail"): the server checks the password through the Identity
// Toolkit REST API, applies the account + IP lockout (5 failures / 15 min), Turnstile from the 3rd
// failure (20 per hour on the account: mandatory), then mints the session cookie.

export const TURNSTILE_AFTER_FAILURES = 3;

export interface LoginKeys {
  account: string;
  accountIp: string;
}

/** Outcome of countAttempt: how many attempts the account + IP still has after this one. */
export interface LoginAttempt {
  remaining: number;
}

export function loginKeys(email: string, ipBucket: string): LoginKeys {
  const account = emailNormHash(email);
  return { account, accountIp: `${account}:${ipBucket}` };
}

/** 429 `account_locked` once this account + IP exhausted its failures; Retry-After is the real time left on the lock. */
export async function assertNotLocked(keys: LoginKeys): Promise<{ failures: number; accountFailures: number; accountFailureLimit: number }> {
  // Thresholds of the limiters as applied (config/abuse overrides included).
  const [state, accountFailures, pair, account] = await Promise.all([
    limitState("login.fail.accountIp", keys.accountIp),
    consumedPoints("login.fail.account", keys.account),
    rateLimitDefinition("login.fail.accountIp"),
    rateLimitDefinition("login.fail.account"),
  ]);
  // Both limits are policy "closed": an unreadable counter never reads as "no failures" (a lock or
  // a mandatory Turnstile would silently lift), the same answer as the staff login.
  if (!state || accountFailures === null) throw unavailable("rate limiter unavailable");
  const result = { failures: state.consumedPoints, accountFailures, accountFailureLimit: account.points };
  if (result.failures >= pair.points) {
    const retryAfter = state.msBeforeNext > 0 ? Math.ceil(state.msBeforeNext / 1000) : (pair.blockDuration ?? pair.duration);
    throw new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(retryAfter) } });
  }
  return result;
}

/**
 * Counts the attempt on the account + IP before the password is looked at, atomically: a burst of
 * parallel attempts past the allowance is refused here (429), where a read-then-count would have
 * let every one of them reach Firebase Auth. A right password forgets the counter (resetLimit).
 */
export async function countAttempt(keys: LoginKeys): Promise<LoginAttempt> {
  const outcome = await consumeLimit("login.fail.accountIp", keys.accountIp);
  if (outcome.ok) return { remaining: outcome.remaining };
  if (outcome.reason === "limited") throw new HttpError(429, "account_locked", undefined, { headers: { "Retry-After": String(Math.max(1, outcome.retryAfterSeconds)) } });
  throw unavailable("rate limiter unavailable");
}

/**
 * Counts a failed password check on the account (20 per hour: Turnstile mandatory). The attempt
 * that exhausted the account + IP allowance starts the lock for the full blockDuration from now
 * (not for what is left of the window opened by the first failure, which is all a plain counter
 * would give).
 */
export async function recordFailure(keys: LoginKeys, attempt: LoginAttempt): Promise<void> {
  await consumeLimit("login.fail.account", keys.account);
  if (attempt.remaining === 0) await blockLimit("login.fail.accountIp", keys.accountIp);
}

/** Password check through Identity Toolkit; a bad credential counts as a failure (401), a disabled account is 403. */
export async function checkPassword(email: string, password: string, keys: LoginKeys, attempt: LoginAttempt): Promise<{ localId: string; idToken: string }> {
  try {
    return await signInWithPassword(email, password);
  } catch (error) {
    const failure = classifySignInError(error);
    if (failure === null) throw error;
    if (failure === "invalid") {
      await recordFailure(keys, attempt);
      throw new HttpError(401, "invalid_credentials");
    }
    if (failure === "disabled") throw new HttpError(403, "account_disabled");
    throw unavailable("Firebase Auth refused the sign-in");
  }
}

async function login(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, loginSchema);
  // §6 "une IP n'est jamais bloquée net": past 300 attempts per hour an IP (CGNAT: hundreds of
  // subscribers behind it) escalates to Turnstile instead of a 429. The store being down still
  // refuses (policy "closed"). Device and account keys keep their hard answers.
  // An IPv6 client also counts on its /48 (§6), with the same escalation.
  const ipOutcome = await consumeLimit("login.ip", flow.identity.ipBucket);
  if (!ipOutcome.ok && ipOutcome.reason === "unavailable") assertLimit("login.ip", ipOutcome);
  const networkOutcome = flow.identity.ip48 ? await consumeLimit("login.ip48", flow.identity.ip48) : null;
  if (networkOutcome && !networkOutcome.ok && networkOutcome.reason === "unavailable") assertLimit("login.ip48", networkOutcome);
  const ipEscalated = !ipOutcome.ok || (networkOutcome !== null && !networkOutcome.ok);
  const keys = loginKeys(input.email, flow.identity.ipBucket);
  const { failures, accountFailures, accountFailureLimit } = await assertNotLocked(keys);

  // The 30-minute pass lifts the IP and account + IP escalations only: 20 failures per hour on
  // the account (an attack spread over many IPs) make Turnstile mandatory on every attempt.
  const pass = hasPass(flow, request);
  const turnstileNeeded = ((failures >= TURNSTILE_AFTER_FAILURES || ipEscalated) && !pass) || accountFailures >= accountFailureLimit;
  if (turnstileNeeded) {
    if (!input.turnstileToken) return respond<LoginResponse>(flow, { status: "turnstile_required" });
    await checkTurnstile(flow, input.turnstileToken, "login");
  }

  // Counted before the check (atomic), forgotten as soon as the password is right: a pending,
  // disabled or staff account answered below is not a failed attempt.
  const attempt = await countAttempt(keys);
  const result = await checkPassword(input.email, input.password, keys, attempt);
  await resetLimit("login.fail.accountIp", keys.accountIp);
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
  await logConnection({ uid: record.uid, event: "login", ip: flow.identity.ip });
  const body: LoginResponse = { status: "signed_in", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

export const handleLogin = anonymous(login);
