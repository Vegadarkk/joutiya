import { handleStaffConversation } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// GET /api/admin/conversations/{cid}?reason=: staff reading of a reported or held conversation, audited (design D18).
export const dynamic = "force-dynamic";
export const GET = apiRoute(handleStaffConversation);
