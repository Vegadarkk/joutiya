import { apiRoute } from "@/lib/http/route";
import { handleMe } from "@/lib/pro/handlers";

// GET /api/pro/me: the signed-in account's shop or application (phase 7 design §4).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleMe);
