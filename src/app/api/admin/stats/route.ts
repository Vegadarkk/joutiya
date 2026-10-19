import { handleStats } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/stats: queues, time to decision, appeal reversal rate (design D24), cached 5 minutes.
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleStats);
