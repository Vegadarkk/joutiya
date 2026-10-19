import { apiRoute } from "@/lib/http/route";
import { handleStream } from "@/lib/messaging/stream";

// GET /api/messages/stream: live messaging events, server-sent (design phase-5 D2).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleStream);
