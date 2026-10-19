import { handleAppealQueue } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/appeals: open appeals, oldest first (design D16, D24).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleAppealQueue);
