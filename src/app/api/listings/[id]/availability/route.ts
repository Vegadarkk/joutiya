import { handleAvailability } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// PUT /api/listings/{id}/availability: a car rental's blocked periods (rental pack §3).
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handleAvailability(request, context.params));
