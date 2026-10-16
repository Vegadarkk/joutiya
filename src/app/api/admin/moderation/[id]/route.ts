import { requireStaff } from "@/lib/auth/guards";
import { listingIdSchema } from "@/lib/contracts/listings";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { apiRoute, json } from "@/lib/http/route";
import { decide, moderationReview, type ModerationReview } from "@/lib/listings/moderation-actions";
import { moderationDecisionRequestSchema, type ModerationDecisionResponse } from "@/lib/moderation/decisions";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import type { RateLimitId } from "@/config/rate-limits";

// One listing of the moderation queue (design D9): the review (GET) and the decision (POST,
// approve or reject with a reason template). Moderators and admins, admin host only.

/** Per-staff decision limit (closed policy); a dedicated "moderation.decision.uid" entry can replace it. */
const DECISION_LIMIT: RateLimitId = "moderation.decision.uid";

async function listingId(context: { params: Promise<Record<string, string | string[] | undefined>> }): Promise<string> {
  const id = listingIdSchema.safeParse((await context.params)["id"]);
  if (!id.success) throw notFound();
  return id.data;
}

export const GET = apiRoute(async (request, context) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  const review = await moderationReview(await listingId(context));
  if (!review) throw notFound();
  return json<{ review: ModerationReview }>({ review });
});

export const POST = apiRoute(async (request, context) => {
  const ctx = await requireStaff(request, { mutation: true, roles: ["moderator", "admin"] });
  const id = await listingId(context);
  await enforceLimit(DECISION_LIMIT, ctx.user.uid);
  const body = await readJson(request, moderationDecisionRequestSchema);
  return json<ModerationDecisionResponse>(await decide(ctx, id, body, requestIdentity(request.headers)));
});
