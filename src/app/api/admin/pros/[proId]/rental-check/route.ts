import { requireStaff } from "@/lib/auth/guards";
import { rentalCheckDecisionSchema, type RentalCheckDecisionResponse } from "@/lib/contracts/pro";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { decideRentalCheck } from "@/lib/pro/rental-check";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// A car rental agency's licence document the AI check left in doubt (decision 5): POST
// /api/admin/pros/{proId}/rental-check verifies it (badge « agrément contrôlé sur document ») or
// refuses it with a reason shown to the agency. Moderators and admins, admin host only.

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  await enforceLimit("pro.decision.uid", ctx.user.uid);
  const body = await readJson(request, rentalCheckDecisionSchema);
  return json<RentalCheckDecisionResponse>(await decideRentalCheck(ctx, id.data, body, requestIdentity(request.headers)));
});
