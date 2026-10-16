import { handleResetRequest } from "@/lib/auth/password";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/password/reset: reset link by mail; same 202 whether the account exists.
export const POST = apiRoute(handleResetRequest);
