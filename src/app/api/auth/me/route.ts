import { handleMe } from "@/lib/auth/session-handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/auth/me: the caller's session summary, or null.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleMe);
