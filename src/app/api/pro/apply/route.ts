import { handleApply } from "@/lib/pro/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/pro/apply: Pro application with the KYBC identifiers and pieces (phase 7 design §4).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleApply);
