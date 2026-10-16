import { handleDecisionGet } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/decisions/{id}: a statement of reasons and its appeal (design D13, D16).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleDecisionGet);
