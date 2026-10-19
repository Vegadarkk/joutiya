import { apiRoute } from "@/lib/http/route";
import { handleUnread } from "@/lib/messaging/handlers";

// GET /api/messages/unread: { total } for the badge outside /messages (Valkey, design phase-5 D3).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleUnread);
