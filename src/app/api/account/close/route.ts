import { handleCloseAccount } from "@/lib/account/close";
import { apiRoute } from "@/lib/http/route";

// POST /api/account/close: closes the signed-in member's account (phase 5 D26, lot L7).
export const POST = apiRoute(handleCloseAccount);
