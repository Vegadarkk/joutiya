import { apiRoute } from "@/lib/http/route";
import { handleMyReviews } from "@/lib/reviews/handlers";

// GET /api/account/reviews?sens=recus|donnes: the signed-in member's reviews (vitrine-avis §2).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleMyReviews);
