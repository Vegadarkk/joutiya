import { handleAccountExport } from "@/lib/account/export";
import { apiRoute } from "@/lib/http/route";

// GET /api/account/export: the signed-in member's personal data as a JSON file (phase 5 D26, lot L7).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleAccountExport);
