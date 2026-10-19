import { apiRoute } from "@/lib/http/route";
import { handleQueue } from "@/lib/reports/handlers";

// GET /api/admin/reports: report queues by priority and due date (design D24), staff only.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleQueue);
