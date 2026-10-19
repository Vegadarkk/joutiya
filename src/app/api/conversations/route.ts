import { apiRoute } from "@/lib/http/route";
import { handleInbox, handleStart } from "@/lib/messaging/handlers";

// GET /api/conversations?cursor=: the inbox (design phase-5 D2). POST: first message about a
// listing, Turnstile always (D4).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleInbox);
export const POST = apiRoute(handleStart);
