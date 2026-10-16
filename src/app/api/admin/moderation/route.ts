import { requireStaff } from "@/lib/auth/guards";
import { apiRoute, json } from "@/lib/http/route";
import { moderationQueue, type ModerationQueueResponse } from "@/lib/listings/moderation-actions";

// Moderation queue of the back office (design D9): listings held by the pre-moderation, oldest first.

export const GET = apiRoute(async (request) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  return json<ModerationQueueResponse>(await moderationQueue());
});
