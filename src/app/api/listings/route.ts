import { handleCreate } from "@/lib/listings/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/listings: a new draft (design §3). GET is not served: the owner lists through /mine.
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleCreate);
