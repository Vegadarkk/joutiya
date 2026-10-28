import { apiRoute } from "@/lib/http/route";
import { handleReplyReview } from "@/lib/reviews/handlers";

// POST /api/reviews/{id}/reply: the reviewed seller's one public reply (vitrine-avis §2).
export const POST = apiRoute((request, context) => handleReplyReview(request, context.params));
