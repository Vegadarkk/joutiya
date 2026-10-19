import { requireStaff } from "@/lib/auth/guards";
import { proPhoneCheckSchema, type ProPhoneCheckResponse } from "@/lib/contracts/pro";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { checkPhoneByCall } from "@/lib/pro/review";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// The moderator's call to the applicant's number (phase 7, while the WhatsApp check is parked):
// POST /api/admin/pros/{proId}/phone records the outcome; `verified` marks the number verified on
// the account, which the verify decision needs. Moderators and admins, admin host only.

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  await enforceLimit("pro.decision.uid", ctx.user.uid);
  const body = await readJson(request, proPhoneCheckSchema);
  return json<ProPhoneCheckResponse>(await checkPhoneByCall(ctx, id.data, body, requestIdentity(request.headers)));
});
