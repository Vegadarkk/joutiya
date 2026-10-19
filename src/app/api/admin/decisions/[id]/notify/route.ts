import { handleResendNotice } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/admin/decisions/{id}/notify: the statement of reasons sent again (design D13, audit D1a-08).
export const dynamic = "force-dynamic";
export const POST = apiRoute(handleResendNotice);
