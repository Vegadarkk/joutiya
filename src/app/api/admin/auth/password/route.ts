import { setPassword } from "@/lib/auth/staff";
import { apiRoute } from "@/lib/http/route";

// First password of an invited member (invitation link), or a later reset.
export const POST = apiRoute((request) => setPassword(request));
