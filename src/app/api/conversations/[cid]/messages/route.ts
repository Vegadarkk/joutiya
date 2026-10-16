import { apiRoute } from "@/lib/http/route";
import { handleSend } from "@/lib/messaging/handlers";

// POST /api/conversations/{cid}/messages: a message in an existing conversation (design phase-5 D4).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleSend(request, context.params));
