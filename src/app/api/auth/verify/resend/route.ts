import { handleVerifyResend } from "@/lib/auth/signup";
import { apiRoute } from "@/lib/http/route";

// POST /api/auth/verify/resend: new verification link for a pending account; always 202.
export const POST = apiRoute(handleVerifyResend);
