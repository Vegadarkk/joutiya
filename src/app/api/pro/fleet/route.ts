import { apiRoute } from "@/lib/http/route";
import { handleFleet, handleFleetSave } from "@/lib/listings/handlers";

// GET /api/pro/fleet, PUT /api/pro/fleet: fleet planning of a car rental agency (rental pack §3).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleFleet);
export const PUT = apiRoute(handleFleetSave);
