import { apiRoute } from "@/lib/http/route";
import { handleStart } from "@/lib/messaging/handlers";

// POST /api/conversations: first message about a listing, Turnstile always (design phase-5 D4).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleStart);
