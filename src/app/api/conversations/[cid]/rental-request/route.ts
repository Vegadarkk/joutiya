import { handleRentalRequest } from "@/lib/rental-requests/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/conversations/{cid}/rental-request: request, accept, decline or withdraw a car rental booking request (rental pack §6).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleRentalRequest(request, context.params));
