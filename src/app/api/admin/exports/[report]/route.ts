import { apiRoute } from "@/lib/http/route";
import { handleBillingExport } from "@/lib/payments/exports-handler";

// GET /api/admin/exports/{report}?period=: tax exports as CSV (phase 7 design §8), admin only.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleBillingExport);
