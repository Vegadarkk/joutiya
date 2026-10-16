import { requireUser } from "@/lib/auth/guards";
import type { PhoneStartResponse } from "@/lib/contracts/auth";
import { phoneStartSchema } from "@/lib/contracts/auth";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { HttpError, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { normalizeMoroccanMobile } from "@/lib/phone/normalize";
import { isPhoneVerificationConfigured, phoneVerifier } from "@/lib/phone-verify";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// POST /api/auth/phone/start (§6 "Vérification WhatsApp"): Moroccan mobiles only; 3 per day per
// account, 5 per day per IP /64, 1 per minute per number and account; one verified number per
// account. A number verified by another account is accepted: proof of possession wins when the
// code arrives (src/lib/phone-verify/inbound.ts), and refusing would tell whether a number is
// registered. The answer carries the one-time code and the wa.me link the user sends from their
// own WhatsApp.
export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser(request, { mutation: true });
  const body = await readJson(request, phoneStartSchema);
  const { e164 } = normalizeMoroccanMobile(body.phone);
  if (!isPhoneVerificationConfigured()) throw unavailable("phone verification is not configured");
  const identity = requestIdentity(request.headers);
  await enforceLimit("phone.uid", user.uid);
  await enforceLimit("phone.ip", identity.ipBucket);
  // Keyed on the account too: a stranger's start must not lock the owner out of their own number.
  await enforceLimit("phone.number", `${user.uid}:${e164}`);
  const account = await getUserPrivate(user.uid);
  if (account?.phoneVerifiedAt) throw new HttpError(409, "conflict", "phone already verified for this account");
  const challenge = await phoneVerifier().start(user.uid, e164);
  const response: PhoneStartResponse = {
    status: "pending",
    code: challenge.code,
    waLink: challenge.waLink,
    number: challenge.number,
    expiresAt: challenge.expiresAt.toISOString(),
  };
  return json(response);
});
