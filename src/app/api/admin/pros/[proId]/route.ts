import { requireStaff } from "@/lib/auth/guards";
import { proDecisionSchema, type ProDecisionResponse, type ProReview } from "@/lib/contracts/pro";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { proIdSchema } from "@/lib/pro/profile-schema";
import { decideApplication, proReview } from "@/lib/pro/review";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// One Pro application of the back office (phase 7 design §4): the review (GET) and the decision
// (POST, verify or reject with the moderator's reason). Moderators and admins, admin host only.

export const dynamic = "force-dynamic";

async function proId(context: { params: Promise<Record<string, string | string[] | undefined>> }): Promise<string> {
  const id = proIdSchema.safeParse((await context.params)["proId"]);
  if (!id.success) throw notFound();
  return id.data;
}

export const GET = apiRoute(async (request, context) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  const review = await proReview(await proId(context));
  if (!review) throw notFound();
  return json<{ review: ProReview }>({ review });
});

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = await proId(context);
  await enforceLimit("pro.decision.uid", ctx.user.uid);
  const body = await readJson(request, proDecisionSchema);
  return json<ProDecisionResponse>(await decideApplication(ctx, id, body, requestIdentity(request.headers)));
});
