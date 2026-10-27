import { handlePhoneRevoke } from "@/lib/decisions/handlers";
import { apiRoute } from "@/lib/http/route";

// DELETE /api/admin/users/{uid}/phone: withdraws the account's verified number and badge (audit C1-02).
export const dynamic = "force-dynamic";
export const DELETE = apiRoute(handlePhoneRevoke);
