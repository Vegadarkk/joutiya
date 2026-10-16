import { apiRoute } from "@/lib/http/route";
import { handleKybcSign } from "@/lib/pro/handlers";

export const dynamic = "force-dynamic";

export const POST = apiRoute(handleKybcSign);
