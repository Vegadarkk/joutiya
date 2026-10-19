import "server-only";
import { actionSchema, type ActionResponse } from "@/lib/contracts/auth";
import { auth } from "@/lib/firebase/admin";
import { readClaims } from "@/lib/firebase/claims";
import { applyEmailVerificationCode, verifyPasswordResetCode, type OobResult } from "@/lib/firebase/rest";
import { createSessionForUid } from "@/lib/firebase/session";
import { HttpError } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { logConnection } from "@/lib/logging/connection-logs";
import { enforceIpLimit } from "@/lib/rate-limit/limiter";
import { userByEmail, withCodeErrors } from "./accounts";
import { activateMember } from "./activation";
import { anonymous, beginAnonymous, finish, respond } from "./anonymous";
import { signedIn } from "./respond";
import { sessionSummary } from "./summary";

// /action links of our mails (§6): the verification code activates the account (role
// "individual") and signs the person in; a reset code is only checked here, the new password goes
// to /api/auth/password/confirm.

/** Applies a VERIFY_EMAIL code. The emulator answers 501 to a code of another type where production says 400: ask the code its type before giving up. */
async function applyVerification(oobCode: string): Promise<OobResult> {
  try {
    return await withCodeErrors(() => applyEmailVerificationCode(oobCode));
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "unavailable") throw error;
    const check = await verifyPasswordResetCode(oobCode).catch(() => null);
    if (check?.requestType && check.requestType !== "VERIFY_EMAIL") throw new HttpError(400, "invalid_code");
    throw error;
  }
}

async function uidOf(result: OobResult): Promise<string> {
  if (result.localId) return result.localId;
  const record = result.email ? await userByEmail(result.email) : null;
  if (!record) throw new HttpError(400, "invalid_code");
  return record.uid;
}

/** The e-mail of a PASSWORD_RESET code, without consuming it. */
export async function checkResetCode(oobCode: string): Promise<string> {
  const result = await withCodeErrors(() => verifyPasswordResetCode(oobCode));
  if ((result.requestType && result.requestType !== "PASSWORD_RESET") || !result.email) throw new HttpError(400, "invalid_code");
  return result.email;
}

async function action(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, actionSchema);
  await enforceIpLimit("action.ip", flow.identity);

  if (input.mode === "resetPassword") {
    const email = await checkResetCode(input.oobCode);
    return respond<ActionResponse>(flow, { status: "reset_ok", email });
  }

  const result = await applyVerification(input.oobCode);
  const uid = await uidOf(result);
  const record = await auth().getUser(uid);
  if (record.disabled) throw new HttpError(403, "account_disabled");
  const claims = readClaims(record.customClaims ?? {});
  if (!(await activateMember(uid, claims))) return respond<ActionResponse>(flow, { status: "verified", session: null });
  const minted = await createSessionForUid(uid);
  // The verification link opens a 14-day session: a sign-in for connectionLogs like any other.
  await logConnection({ uid, event: "login", ip: flow.identity.ip, userAgent: flow.userAgent });
  const body: ActionResponse = { status: "verified", session: await sessionSummary(minted.user) };
  return finish(flow, signedIn(minted, body));
}

export const handleAction = anonymous(action);
