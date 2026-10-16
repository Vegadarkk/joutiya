import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { passwordChangeSchema, resetConfirmSchema, resetRequestSchema, type PasswordChangeResponse, type ResetConfirmResponse, type ResetRequestResponse } from "@/lib/contracts/auth";
import { emailNormHash, getUser, linkProvider } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { isStaff, readClaims } from "@/lib/firebase/claims";
import { confirmPasswordReset } from "@/lib/firebase/rest";
import { createSessionForUid, revokeSessions } from "@/lib/firebase/session";
import { HttpError, forbidden } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { logger } from "@/lib/logging/logger";
import { enforceLimit, resetLimit } from "@/lib/rate-limit/limiter";
import { accountByEmail, displayNameFor, userByEmail, withCodeErrors } from "./accounts";
import { activateMember } from "./activation";
import { checkResetCode } from "./action";
import { anonymous, beginAnonymous, checkTurnstile, respond, uniformDuration, userAgentOf } from "./anonymous";
import { assertNotLocked, checkPassword, loginKeys } from "./login";
import { sendPasswordChangedMail, sendResetMail } from "./mails";
import { assertPasswordPolicy } from "./password-policy";
import { applyDevice, deviceOf, signedIn } from "./respond";
import { sessionSummary } from "./summary";

// Password reset (§6 "Réinitialisation du mot de passe": same answer whether the account exists)
// and password change by a signed-in person (re-authentication, every other session revoked).

async function resetRequest(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, resetRequestSchema);
  await enforceLimit("reset.ip", flow.identity.ipBucket);
  await enforceLimit("reset.email", emailNormHash(input.email));
  await checkTurnstile(flow, input.turnstileToken, "reset");
  const record = await accountByEmail(input.email);
  // Staff accounts reset their password on the back office only, behind Cloudflare Access (§6
  // "Personnel"): the public flow never mails them, and answers the same 202.
  const staff = record ? isStaff(readClaims(record.customClaims ?? {})) : false;
  if (record?.email && !record.disabled && !staff && record.providerData.some((provider) => provider.providerId === "password")) {
    const profile = await getUser(record.uid);
    await sendResetMail({ email: record.email, displayName: displayNameFor(profile, record, record.email), locale: input.locale });
  }
  const body: ResetRequestResponse = { status: "sent" };
  // Same duration whether the account exists (timing enumeration).
  await uniformDuration(flow);
  return respond(flow, body, { status: 202 });
}

async function resetConfirm(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, resetConfirmSchema);
  await enforceLimit("action.ip", flow.identity.ipBucket);
  const email = await checkResetCode(input.oobCode);
  const record = await userByEmail(email);
  // A staff password is never set from the public host (the back office, behind Access, has its own flow).
  if (record && isStaff(readClaims(record.customClaims ?? {}))) throw new HttpError(400, "invalid_code");
  const profile = record ? await getUser(record.uid) : null;
  assertPasswordPolicy(input.password, { email, displayName: profile?.displayName ?? record?.displayName });
  await withCodeErrors(() => confirmPasswordReset(input.oobCode, input.password));
  if (record) {
    await revokeSessions(record.uid);
    // Firebase marks the e-mail verified on a reset: a pending account becomes a member.
    await activateMember(record.uid, readClaims(record.customClaims ?? {}));
    // The account has a usable password again (a Google sign-in may have dropped it, src/lib/auth/google.ts).
    await linkProvider(record.uid, "password").catch((error: unknown) => logger.warn({ err: (error as Error).message }, "providers update skipped"));
    await sendPasswordChangedMail({ email: record.email ?? email, displayName: displayNameFor(profile, record, email), locale: profile?.locale ?? "fr" });
    await logConnection({ uid: record.uid, event: "password_reset", ip: flow.identity.ip, userAgent: flow.userAgent });
  }
  const body: ResetConfirmResponse = { status: "password_reset" };
  return respond(flow, body);
}

export async function handlePasswordChange(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true, checkRevoked: true });
  const input = await readJson(request, passwordChangeSchema);
  const device = deviceOf(request);
  const { uid } = context.user;
  await enforceLimit("account.mutation.uid", uid);
  const email = context.user.email ?? (await auth().getUser(uid)).email;
  if (!email) throw forbidden("this account has no password");
  const keys = loginKeys(email, device.identity.ipBucket);
  await assertNotLocked(keys);
  await checkPassword(email, input.currentPassword, keys);
  const profile = await getUser(uid);
  assertPasswordPolicy(input.password, { email, displayName: profile?.displayName });
  await auth().updateUser(uid, { password: input.password });
  await revokeSessions(uid);
  const minted = await createSessionForUid(uid);
  await resetLimit("login.fail.accountIp", keys.accountIp);
  await sendPasswordChangedMail({ email, displayName: displayNameFor(profile, null, email), locale: profile?.locale ?? "fr" });
  await logConnection({ uid, event: "password_change", ip: device.identity.ip, userAgent: userAgentOf(request) });
  const body: PasswordChangeResponse = { status: "changed", session: await sessionSummary(minted.user) };
  return applyDevice(signedIn(minted, body), device);
}

export const handleResetRequest = anonymous(resetRequest);

export const handleResetConfirm = anonymous(resetConfirm);
