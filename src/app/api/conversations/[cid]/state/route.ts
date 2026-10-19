import { apiRoute } from "@/lib/http/route";
import { handleState } from "@/lib/messaging/handlers";

// POST /api/conversations/{cid}/state: archive, delete for me, block or unblock (design phase-5 D6, D7).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleState(request, context.params));
