import { apiRoute } from "@/lib/http/route";
import { handleTargetView } from "@/lib/reports/handlers";

// GET /api/admin/reports/target?key={type}:{id}: a reported target with its history (design D24), staff only.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleTargetView);
