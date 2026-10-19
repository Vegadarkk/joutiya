import { apiRoute } from "@/lib/http/route";
import { handleConversation } from "@/lib/messaging/handlers";

// GET /api/conversations/{cid}: one inbox row, refetched on a live event (design phase-5 D2).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleConversation(request, context.params));
