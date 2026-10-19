import { apiRoute } from "@/lib/http/route";
import { handleKybcComplete } from "@/lib/pro/handlers";

export const dynamic = "force-dynamic";

export const POST = apiRoute(async (request, context) => handleKybcComplete(request, (await context.params)["id"]));
