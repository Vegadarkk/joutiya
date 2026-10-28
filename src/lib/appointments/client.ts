import { apiPost } from "@/lib/auth/client";
import type { AppointmentAction, AppointmentResponse } from "@/lib/contracts/appointments";
import { MESSAGING_API } from "@/lib/contracts/endpoints";

// Browser side of POST /api/conversations/{cid}/appointment (CSRF header, lib/auth/client).

export function postAppointmentAction(cid: string, action: AppointmentAction): Promise<AppointmentResponse> {
  return apiPost<AppointmentResponse>(MESSAGING_API.appointment(cid), action);
}
