import { apiRoute } from "@/lib/http/route";
import { handleSend, handleThread } from "@/lib/messaging/handlers";

// GET /api/conversations/{cid}/messages?cursor= | ?after=: a thread page (design phase-5 D2).
// POST: a message in an existing conversation (D4).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleThread(request, context.params));
export const POST = apiRoute((request, context) => handleSend(request, context.params));
