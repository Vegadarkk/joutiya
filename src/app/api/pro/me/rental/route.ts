import { apiRoute } from "@/lib/http/route";
import { handleRentalAgency } from "@/lib/pro/handlers";

// PUT /api/pro/me/rental: the car rental agency's settings (rental pack §5).
export const dynamic = "force-dynamic";
export const PUT = apiRoute(handleRentalAgency);
