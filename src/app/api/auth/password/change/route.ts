import { handlePasswordChange } from "@/lib/auth/password";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/password/change: re-authentication, new password, other sessions revoked.
export const POST = apiRoute(handlePasswordChange);
