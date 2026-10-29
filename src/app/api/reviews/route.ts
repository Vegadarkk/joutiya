import { apiRoute } from "@/lib/http/route";
import { handleCreateReview, handleListReviews } from "@/lib/reviews/handlers";

// GET /api/reviews?vendeur={publicId}&apres={cursor}: a seller's published reviews (public).
// POST /api/reviews: the buyer of a conversation reviews the seller (vitrine-avis §2).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleListReviews);
export const POST = apiRoute(handleCreateReview);
