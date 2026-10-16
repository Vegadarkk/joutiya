import { handleSign } from "@/lib/uploads/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/uploads/sign: a presigned PUT to the quarantine bucket (design §3 MEDIA_API).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleSign);
