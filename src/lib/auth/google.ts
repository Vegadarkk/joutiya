import "server-only";
import { randomBytes } from "node:crypto";
import type { UpdateRequest, UserRecord } from "firebase-admin/auth";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { CGU_VERSION, TRANSFERS_CONSENT_VERSION, displayNameSchema, googleSchema, type GoogleInput, type GoogleResponse } from "@/lib/contracts/auth";
import { createAccountDocuments, findUidByEmail, getUser, isEmailTaken, linkProvider, unlinkProvider } from "@/lib/db/repositories/users";
import { serverEnv } from "@/lib/env";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims, setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { HttpError, forbidden, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { safeEqual } from "@/lib/security/hash";
import { errorCode, localPart, userByEmail } from "./accounts";
import { activateMember } from "./activation";
import { anonymous, beginAnonymous, checkTurnstile, finish, respond, type AnonymousFlow } from "./anonymous";
import { signedIn } from "./respond";
import { sessionSummary } from "./summary";

// Google sign-in through Google Identity Services (PLAN "Research corrections"): the browser sends
// the Google ID token, the server verifies it (signature, issuer, audience, verified e-mail, the
// nonce of this page), then signs the account in or, with the consents and Turnstile, creates it.
// The provider is linked on the Auth record (sub) so the SDK popup flow (/api/auth/session)
// resolves to the same account.

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const PROVIDER = "google.com";

export interface GoogleIdentity {
  /** Stable Google account id: the key of the link, never the e-mail. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** `nonce` claim: the random value the page gave GIS, so a token cannot be replayed from elsewhere. */
  nonce: string | null;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

let testVerifier: GoogleVerifier | null = null;
let googleKeys: JWTVerifyGetKey | undefined;

/** Development and tests without GOOGLE_OAUTH_CLIENT_ID: replaces the signature check. */
export function setGoogleVerifierForTests(verifier: GoogleVerifier | null): void {
  testVerifier = verifier;
}

function keys(): JWTVerifyGetKey {
  googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS), { timeoutDuration: 5000, cooldownDuration: 30_000 });
  return googleKeys;
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleIdentity> {
  const env = serverEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    if (env.APP_ENV === "dev" && testVerifier) return testVerifier(credential);
    throw new HttpError(503, "unavailable", "Google sign-in is not configured");
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(credential, keys(), { issuer: GOOGLE_ISSUERS, audience: env.GOOGLE_OAUTH_CLIENT_ID, algorithms: ["RS256"] }));
  } catch {
    throw new HttpError(401, "invalid_credentials", "Google credential rejected");
  }
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new HttpError(401, "invalid_credentials", "Google credential incomplete");
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: name || null,
    nonce: typeof payload.nonce === "string" && payload.nonce ? payload.nonce : null,
  };
}

/** The token must carry the nonce this page generated (constant-time): a token minted for another page is a replay. */
export function assertNonce(identity: GoogleIdentity, nonce: string): void {
  if (!identity.nonce || !safeEqual(identity.nonce, nonce)) throw new HttpError(403, "invalid_credentials", "Google credential nonce mismatch");
}

/** Google's name reduced to the display-name rules, or null when nothing usable remains. */
export function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.normalize("NFKC").replace(/[^\p{L}\p{M}\p{N} .'’-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  const parsed = displayNameSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
}

/**
 * Links the Google identity on the Auth record (idempotent). A password account whose e-mail was
 * never verified may have been opened by someone else with this address (pre-hijack): Google has
 * just proven who owns it, so that password is replaced by a random one nobody knows before the
 * link, and the owner sets a new one through the reset flow. The link itself is best effort (the
 * sign-in does not depend on it); the password replacement is not.
 */
async function linkGoogleOnRecord(record: UserRecord, identity: GoogleIdentity): Promise<{ passwordDropped: boolean }> {
  const update: UpdateRequest = {};
  const providers = record.providerData.map((provider) => provider.providerId);
  if (!providers.includes(PROVIDER)) update.providerToLink = { providerId: PROVIDER, uid: identity.sub, email: identity.email };
  if (!record.emailVerified) update.emailVerified = true;
  const passwordDropped = !record.emailVerified && providers.includes("password");
  if (passwordDropped) update.password = randomBytes(64).toString("base64url");
  if (Object.keys(update).length === 0) return { passwordDropped: false };
  try {
    await auth().updateUser(record.uid, update);
  } catch (error) {
    if (passwordDropped) {
      logger.error({ code: errorCode(error) }, "google sign-in: pending password could not be replaced");
      throw unavailable("account update failed");
    }
    logger.warn({ code: errorCode(error) }, "google provider link skipped");
  }
  return { passwordDropped };
}

async function signInExisting(flow: AnonymousFlow, uid: string, identity: GoogleIdentity, event: "google_login" | "google_signup"): Promise<Response> {
  const record = await auth().getUser(uid);
  if (record.disabled) throw new HttpError(403, "account_disabled");
  const claims = readClaims(record.customClaims ?? {});
  if (isStaff(claims)) throw forbidden("staff accounts sign in on the back office");
  const { passwordDropped } = await linkGoogleOnRecord(record, identity);
  const warn = (error: unknown) => logger.warn({ err: (error as Error).message }, "providers update skipped");
  if (passwordDropped) await unlinkProvider(uid, "password").catch(warn);
  await linkProvider(uid, PROVIDER).catch(warn);
  // Google verified the e-mail: a pending password account is activated by this sign-in.
  if (!(await activateMember(uid, claims))) throw new HttpError(403, "role_missing");
  const minted = await createSessionForUid(uid);
  await logConnection({ uid, event, ip: flow.identity.ip, userAgent: flow.userAgent });
  const body: GoogleResponse = { status: "signed_in", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

/** Auth record for a new Google account; an orphan record with this exact e-mail (no documents) is reused. */
async function ensureAuthUser(identity: GoogleIdentity, displayName: string): Promise<{ uid: string; created: boolean }> {
  try {
    const record = await auth().createUser({ email: identity.email, emailVerified: true, displayName });
    await auth().updateUser(record.uid, { providerToLink: { providerId: PROVIDER, uid: identity.sub, email: identity.email } });
    return { uid: record.uid, created: true };
  } catch (error) {
    if (errorCode(error) !== "auth/email-already-exists") throw error;
    const record = await userByEmail(identity.email);
    if (!record) throw error;
    await linkGoogleOnRecord(record, identity);
    return { uid: record.uid, created: false };
  }
}

async function signUp(flow: AnonymousFlow, input: GoogleInput & { consents: NonNullable<GoogleInput["consents"]> }, identity: GoogleIdentity): Promise<Response> {
  if (!input.turnstileToken) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "turnstileToken", code: "required" }] });
  await checkTurnstile(flow, input.turnstileToken, "google");
  const displayName = sanitizeDisplayName(identity.name) ?? sanitizeDisplayName(localPart(identity.email)) ?? "Membre";
  const { uid, created } = await ensureAuthUser(identity, displayName);
  try {
    await createAccountDocuments({
      uid,
      email: identity.email,
      displayName,
      locale: input.locale,
      consents: { cguVersion: CGU_VERSION, transfersVersion: TRANSFERS_CONSENT_VERSION, marketing: input.consents.marketing },
      provider: PROVIDER,
      activated: true,
    });
  } catch (error) {
    if (created) await auth().deleteUser(uid).catch((cause: unknown) => logger.error({ err: (cause as Error).message }, "orphan auth record after failed google sign-up"));
    if (isEmailTaken(error)) {
      // Two first sign-ins at once: the other one won; sign in to that account.
      if (error.uid === uid) return signInExisting(flow, uid, identity, "google_login");
      // Another account owns a variant of this e-mail (+tag, Gmail dots): never merged into it.
      throw new HttpError(409, "conflict", "an account exists under a variant of this e-mail");
    }
    throw error;
  }
  await setClaims(uid, { role: "individual" });
  const minted = await createSessionForUid(uid);
  await logConnection({ uid, event: "google_signup", ip: flow.identity.ip, userAgent: flow.userAgent });
  const body: GoogleResponse = { status: "signed_in", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

/**
 * The account this Google identity belongs to: the record linked to the Google sub first, then the
 * record with this exact e-mail. The normalized index (+tag stripped, Gmail dots removed) is lossy
 * and never picks the account someone signs into.
 */
async function existingUid(identity: GoogleIdentity): Promise<string | null> {
  try {
    return (await auth().getUserByProviderUid(PROVIDER, identity.sub)).uid;
  } catch (error) {
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }
  return (await userByEmail(identity.email))?.uid ?? null;
}

async function googleSignIn(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, googleSchema);
  await enforceLimit("google.ip", flow.identity.ipBucket);
  await enforceLimit("google.device", flow.identity.deviceKey);
  const identity = await verifyGoogleCredential(input.credential);
  assertNonce(identity, input.nonce);
  if (!identity.emailVerified) throw new HttpError(403, "email_not_verified");

  const uid = await existingUid(identity);
  // An Auth record without documents is an orphan of a failed sign-up: the sign-up path reuses it.
  if (uid && (await getUser(uid))) return signInExisting(flow, uid, identity, "google_login");
  // New account: the sign-up limits apply, a `needs_consent` pass included (§6).
  await enforceLimit("signup.ip", flow.identity.ipBucket);
  await enforceLimit("signup.device", flow.identity.deviceKey);
  if (await findUidByEmail(identity.email)) throw new HttpError(409, "conflict", "an account exists under a variant of this e-mail");
  if (!input.consents) return respond<GoogleResponse>(flow, { status: "needs_consent", email: identity.email, displayName: identity.name });
  return signUp(flow, { ...input, consents: input.consents }, identity);
}

export const handleGoogle = anonymous(googleSignIn);
