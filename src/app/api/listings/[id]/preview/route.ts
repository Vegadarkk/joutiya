import { apiRoute } from "@/lib/http/route";
import { handleListingPreview } from "@/lib/search/preview-handler";

// GET /api/listings/{id}/preview?locale=fr: criteria, description, « Prix repère » and seller type of
// a published listing, for the map's detail panel (Carte vivante). From the search index only.
export const dynamic = "force-dynamic";
export const GET = apiRoute((request, context) => handleListingPreview(request, context.params));
