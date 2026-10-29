import { apiPost } from "@/lib/auth/client";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type { RentalRequestAction, RentalRequestResponse } from "@/lib/contracts/rental-requests";

// Browser side of POST /api/conversations/{cid}/rental-request (CSRF header, lib/auth/client).

export function postRentalRequestAction(cid: string, action: RentalRequestAction): Promise<RentalRequestResponse> {
  return apiPost<RentalRequestResponse>(MESSAGING_API.rentalRequest(cid), action);
}
