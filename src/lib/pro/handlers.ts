import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { uploadIdSchema } from "@/lib/contracts/media";
import { kybcSignSchema, proApplySchema, type ProApplyResponse } from "@/lib/contracts/pro";
import { serverEnv } from "@/lib/env";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { completeKybcUpload, deleteKybcUpload, signKybcUpload } from "./kybc-uploads";
import { proSelf, submitApplication } from "./service";

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

/** POST /api/pro/kybc/uploads: presigned PUT for one KYBC piece (JPEG, PNG or PDF). */
export async function handleKybcSign(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, kybcSignSchema);
  return json(await signKybcUpload({ auth, ip: requestIdentity(request.headers).ip }, input), { status: 201 });
}

/** POST /api/pro/kybc/uploads/{id}/complete: checks the piece and stores it in the private bucket. */
export async function handleKybcComplete(request: Request, rawId: unknown): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = uploadIdSchema.safeParse(rawId);
  if (!id.success) throw notFound();
  return json(await completeKybcUpload({ auth, ip: requestIdentity(request.headers).ip }, id.data));
}

/** DELETE /api/pro/kybc/uploads/{id}: removes a piece of the caller that no application under review lists. */
export async function handleKybcDelete(request: Request, rawId: unknown): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = uploadIdSchema.safeParse(rawId);
  if (!id.success) throw notFound();
  // Before the first Firestore read, like the photo delete (shared Spark quotas).
  await enforceLimit("upload.delete.uid", auth.user.uid);
  await deleteKybcUpload({ auth, ip: requestIdentity(request.headers).ip }, id.data);
  return noContent();
}

/** GET /api/pro/me: the signed-in account's shop or application. */
export async function handleMe(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  await enforceLimit("pro.read.uid", auth.user.uid);
  return json(await proSelf(auth));
}
