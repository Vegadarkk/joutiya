import { logout } from "@/lib/auth/staff";
import { apiRoute } from "@/lib/http/route";

export const POST = apiRoute((request) => logout(request));
