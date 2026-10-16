import { login } from "@/lib/auth/staff";
import { apiRoute } from "@/lib/http/route";

// Staff password sign-in on the admin host (§6 "Personnel"); the flow lives in src/lib/auth/staff.ts.
export const POST = apiRoute((request) => login(request));
