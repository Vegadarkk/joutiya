import { handleDecide } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/admin/decisions: one decision on one target, closing its open reports (design D13).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleDecide);
