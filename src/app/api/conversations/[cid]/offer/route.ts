import { apiRoute } from "@/lib/http/route";
import { handleOffer } from "@/lib/offers/handlers";

// POST /api/conversations/{cid}/offer: make, accept, decline, counter or withdraw a price offer (Carte vivante lot 5).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleOffer(request, context.params));
