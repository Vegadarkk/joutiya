import { apiRoute } from "@/lib/http/route";
import { handleRead } from "@/lib/messaging/handlers";

// POST /api/conversations/{cid}/read: read receipt, zeroes my unread count (design phase-5 D7).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleRead(request, context.params));
