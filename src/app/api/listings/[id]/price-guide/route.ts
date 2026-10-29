import { apiRoute } from "@/lib/http/route";
import { handlePriceGuide } from "@/lib/price-guide/handlers";

// GET /api/listings/{id}/price-guide: the « Prix repère » of a published listing (Carte vivante lot 5).
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handlePriceGuide(request, context.params));
