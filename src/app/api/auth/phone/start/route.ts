import { requireUser } from "@/lib/auth/guards";
import type { PhoneStartResponse } from "@/lib/contracts/auth";
import { phoneStartSchema } from "@/lib/contracts/auth";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { HttpError, unavailable } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { normalizeMoroccanMobile } from "@/lib/phone/normalize";
import { isPhoneVerificationConfigured, phoneVerifier } from "@/lib/phone-verify";
import { isPhoneVerifiedByOther } from "@/lib/phone-verify/accounts";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// POST /api/auth/phone/start (§6 "Vérification WhatsApp"): Moroccan mobiles only; 3 per day per
// account, 5 per day per IP /64, 1 per minute per number; one verified number per account. The
// answer carries the one-time code and the wa.me link the user sends from their own WhatsApp.
export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser(request, { mutation: true });
  const body = await readJson(request, phoneStartSchema);
  const { e164 } = normalizeMoroccanMobile(body.phone);
  if (!isPhoneVerificationConfigured()) throw unavailable("phone verification is not configured");
  const identity = requestIdentity(request.headers);
  await enforceLimit("phone.uid", user.uid);
  await enforceLimit("phone.ip", identity.ipBucket);
  await enforceLimit("phone.number", e164);
  const account = await getUserPrivate(user.uid);
  if (account?.phoneVerifiedAt) throw new HttpError(409, "conflict", "phone already verified for this account");
  if (await isPhoneVerifiedByOther(e164, user.uid)) throw new HttpError(409, "conflict", "phone already verified by another account");
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
