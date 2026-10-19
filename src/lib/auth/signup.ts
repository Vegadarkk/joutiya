import "server-only";
import mailchecker from "mailchecker";
import type { Locale } from "@/config/site";
import { CGU_VERSION, TRANSFERS_CONSENT_VERSION, signupSchema, verifyResendSchema, type SignupInput, type SignupResponse, type VerifyResendResponse } from "@/lib/contracts/auth";
import { createAccountDocuments, emailNormHash, findUidByEmail, getUser, isEmailTaken } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { assertQuotas, SIGNUP_QUOTAS } from "@/lib/quota/gate";
import { consumeLimit, enforceLimit } from "@/lib/rate-limit/limiter";
import { HttpError, unavailable } from "@/lib/http/errors";
import { pepperedHash } from "@/lib/security/hash";
import { displayNameFor, errorCode, userByEmail } from "./accounts";
import { anonymous, beginAnonymous, checkTurnstile, deviceIdOf, respond, uniformDuration, type AnonymousFlow } from "./anonymous";
import { sendSignupExistingMail, sendVerificationMail } from "./mails";
import { deleteOrphanRecord, recordState } from "./orphan";
import { assertPasswordPolicy } from "./password-policy";

// Sign-up by e-mail (§6): Turnstile, limits, disposable domains, password policy, then an Auth
// record without role and the Firestore documents; the verification link activates the account.
// An e-mail that already has an account gets the same 202 and a "signupExisting" mail, after the
// same minimum duration (uniformDuration): neither the body nor a clock tells the two apart.

const VERIFICATION_SENT: SignupResponse = { status: "verification_sent" };

/**
 * Same answer as a real sign-up; the owner of the address learns about the attempt by mail, three
 * times per hour at most whatever the +tag or Gmail-dot variant used (mail bombing). Beyond that,
 * or with the store down, the mail is skipped and the answer is unchanged.
 */
async function existingAccountAnswer(flow: AnonymousFlow, uid: string, email: string, locale: Locale): Promise<Response> {
  const allowance = await consumeLimit("signup.existing.email", emailNormHash(email));
  if (allowance.ok) {
    const [profile, record] = await Promise.all([getUser(uid), auth().getUser(uid).catch(() => null)]);
    await sendSignupExistingMail({ uid, email: record?.email ?? email, displayName: displayNameFor(profile, record, email), locale });
  }
  await uniformDuration(flow);
  return respond(flow, VERIFICATION_SENT, { status: 202 });
}

/**
 * Auth record for the new account. An orphan record with this e-mail (a failed sign-up, a purge
 * whose Auth deletion failed) is never adopted: its uid may still key data, so it is deleted and
 * the creation retried once with a fresh uid. A member or staff record answers `created: false`.
 */
async function createAuthUser(input: SignupInput, retry = true): Promise<{ uid: string; created: boolean }> {
  try {
    const record = await auth().createUser({ email: input.email, password: input.password, displayName: input.displayName, emailVerified: false });
    return { uid: record.uid, created: true };
  } catch (error) {
    if (errorCode(error) !== "auth/email-already-exists") throw error;
    const record = await userByEmail(input.email);
    if (!record) throw error;
    if ((await recordState(record)) !== "orphan") return { uid: record.uid, created: false };
    if (!retry) throw unavailable("auth record could not be created");
    await deleteOrphanRecord(record.uid);
    return createAuthUser(input, false);
  }
}

async function signup(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, signupSchema);
  await enforceLimit("signup.ip", flow.identity.ipBucket);
  // Firestore writes degraded (§2): the documents would fail after the Auth record; refused first.
  // Before the device limit (3 a day): a refusal must not use up the retry its Retry-After invites.
  await assertQuotas(SIGNUP_QUOTAS);
  await enforceLimit("signup.device", flow.identity.deviceKey);
  await checkTurnstile(flow, input.turnstileToken, "signup");
  if (!mailchecker.isValid(input.email)) throw new HttpError(400, "disposable_email");
  assertPasswordPolicy(input.password, { email: input.email, displayName: input.displayName });

  const existing = await findUidByEmail(input.email);
  if (existing) return existingAccountAnswer(flow, existing, input.email, input.locale);

  const { uid, created } = await createAuthUser(input);
  if (!created) return existingAccountAnswer(flow, uid, input.email, input.locale);
  // The device this sign-up binds to the browser (its cookie, sent or set by this answer): the
  // verification link opens a session on that device only (src/lib/auth/action.ts).
  const deviceId = deviceIdOf(flow);
  try {
    await createAccountDocuments({
      uid,
      email: input.email,
      displayName: input.displayName,
      locale: input.locale,
      consents: { cguVersion: CGU_VERSION, transfersVersion: TRANSFERS_CONSENT_VERSION, marketing: input.consents.marketing },
      provider: "password",
      ...(deviceId ? { signupDeviceHash: pepperedHash("did", deviceId) } : {}),
    });
  } catch (error) {
    await auth()
      .deleteUser(uid)
      .catch((cause: unknown) => logger.error({ err: (cause as Error).message }, "orphan auth record after failed sign-up"));
    if (isEmailTaken(error)) return existingAccountAnswer(flow, error.uid, input.email, input.locale);
    throw error;
  }
  await sendVerificationMail({ uid, email: input.email, displayName: input.displayName, locale: input.locale });
  await logConnection({ uid, event: "signup", ip: flow.identity.ip });
  await uniformDuration(flow);
  return respond(flow, VERIFICATION_SENT, { status: 202 });
}

/** New verification link for a pending account; always 202 (the e-mail may not exist or be verified). */
async function verifyResend(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, verifyResendSchema);
  await enforceLimit("verify.resend.uid", emailNormHash(input.email));
  await enforceLimit("reset.ip", flow.identity.ipBucket);
  await checkTurnstile(flow, input.turnstileToken, "verify-resend");
  const record = await userByEmail(input.email);
  if (record?.email && !record.emailVerified && !record.disabled) {
    const profile = await getUser(record.uid);
    await sendVerificationMail({ uid: record.uid, email: record.email, displayName: displayNameFor(profile, record, record.email), locale: input.locale });
  }
  const body: VerifyResendResponse = { status: "verification_sent" };
  // Same duration whether a pending account exists (timing enumeration).
  await uniformDuration(flow);
  return respond(flow, body, { status: 202 });
}

export const handleSignup = anonymous(signup);

export const handleVerifyResend = anonymous(verifyResend);
