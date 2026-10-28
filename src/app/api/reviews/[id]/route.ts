import { apiRoute } from "@/lib/http/route";
import { handleDeleteReview } from "@/lib/reviews/handlers";

// DELETE /api/reviews/{id}: the author deletes the review (vitrine-avis §2).
export const DELETE = apiRoute((request, context) => handleDeleteReview(request, context.params));
