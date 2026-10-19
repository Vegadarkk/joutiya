import { handleMyDecisions, handleOpenAppeal } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// Appeals of a signed-in account, suspended ones included (design D16): its decisions (GET), an appeal (POST).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleMyDecisions);
export const POST = apiRoute(handleOpenAppeal);
