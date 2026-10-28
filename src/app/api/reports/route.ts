import { apiRoute } from "@/lib/http/route";
import { handleCreateReport } from "@/lib/reports/handlers";

// POST /api/reports: the notice form (art. 16 DSA, design D10); logic in src/lib/reports.
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleCreateReport);
