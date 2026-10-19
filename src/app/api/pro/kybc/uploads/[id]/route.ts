import { apiRoute } from "@/lib/http/route";
import { handleKybcDelete } from "@/lib/pro/handlers";

export const dynamic = "force-dynamic";

export const DELETE = apiRoute(async (request, context) => handleKybcDelete(request, (await context.params)["id"]));
