import { handleReviewAppeal } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/admin/appeals/{decisionId}: review by another moderator, upheld or reversed (design D16).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleReviewAppeal);
