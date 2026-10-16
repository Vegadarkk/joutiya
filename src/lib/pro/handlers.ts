import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { proApplySchema, type ProApplyResponse } from "@/lib/contracts/pro";
import { serverEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { submitApplication } from "./service";

// Route handlers of /api/pro/** (phase 7 design §4): requireUser (Origin + CSRF on mutations),
// strict body, per-account limiter before the first Firestore read, Turnstile on the application.

export async function handleApply(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, proApplySchema);
  await enforceLimit("pro.apply.uid", auth.user.uid);
  const ip = requestIdentity(request.headers).ip;
  const check = await verifyTurnstile(input.turnstileToken, { action: "pro-apply", remoteIp: ip, hostname: new URL(serverEnv().SITE_URL).hostname });
  if (!check.ok) throw new HttpError(403, "turnstile_failed");
  const { proId } = await submitApplication({ auth, ip }, input);
  const body: ProApplyResponse = { proId, status: "pending_verification" };
  return json(body, { status: 201 });
}
