import { apiRoute } from "@/lib/http/route";
import { handleRentalCheck } from "@/lib/pro/handlers";

// POST /api/pro/me/rental/check: the car rental agency's licence decision, sent for its check (decision 5).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleRentalCheck);
