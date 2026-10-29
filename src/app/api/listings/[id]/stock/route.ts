import { handleStock } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// /api/listings/{id}/stock: PUT the declared stock of a Pro listing (catalogue §3), no screening.
export const dynamic = "force-dynamic";
export const PUT = apiRoute((request, context) => handleStock(request, context.params));
