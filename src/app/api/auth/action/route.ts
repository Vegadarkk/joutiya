import { handleAction } from "@/lib/auth/action";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/action: verification and reset codes of our /action links.
export const POST = apiRoute(handleAction);
