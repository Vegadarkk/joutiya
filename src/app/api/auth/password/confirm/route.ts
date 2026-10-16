import { handleResetConfirm } from "@/lib/auth/password";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/password/confirm: new password for a reset code; every session is revoked.
export const POST = apiRoute(handleResetConfirm);
