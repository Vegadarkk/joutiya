import { apiRoute } from "@/lib/http/route";
import { handleAgency } from "@/lib/pro/handlers";

// PUT /api/pro/me/agency: the shop's sector and the agency's fee schedule (Agence pack design §3).
export const dynamic = "force-dynamic";
export const PUT = apiRoute(handleAgency);
