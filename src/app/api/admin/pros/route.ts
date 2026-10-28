import { requireStaff } from "@/lib/auth/guards";
import type { ProQueueResponse } from "@/lib/contracts/pro";
import { apiRoute, json } from "@/lib/http/route";
import { proQueue } from "@/lib/pro/review";

// KYBC queue of the back office (phase 7 design §4): submitted Pro applications, oldest first.

export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  await requireStaff(request, { roles: ["moderator", "admin"] });
  return json<ProQueueResponse>(await proQueue());
});
