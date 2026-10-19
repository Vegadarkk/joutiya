import { handleBulkDismiss } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/admin/decisions/bulk: P3 dismissals of up to 20 targets (design D24).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleBulkDismiss);
