import { requireUser } from "@/lib/auth/guards";
import type { PhoneStatusResponse } from "@/lib/contracts/auth";
import { apiRoute, json } from "@/lib/http/route";
import { displayPhone } from "@/lib/phone/normalize";
import { phoneVerifier } from "@/lib/phone-verify";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// GET /api/auth/phone/status: polled by the account page while the user sends the code.
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  const { user } = await requireUser(request);
  await enforceLimit("phone.status.uid", user.uid);
  const state = await phoneVerifier().status(user.uid);
  const response: PhoneStatusResponse = {
    status: state.status,
    phone: "phoneE164" in state ? displayPhone(state.phoneE164) : null,
  };
  return json(response);
});
