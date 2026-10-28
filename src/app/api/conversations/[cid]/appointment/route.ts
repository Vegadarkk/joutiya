import { handleAppointment } from "@/lib/appointments/handlers";
import { apiRoute } from "@/lib/http/route";

// POST /api/conversations/{cid}/appointment: propose, confirm, decline, withdraw or cancel an appointment (architecture §5).
export const dynamic = "force-dynamic";
export const POST = apiRoute((request, context) => handleAppointment(request, context.params));
