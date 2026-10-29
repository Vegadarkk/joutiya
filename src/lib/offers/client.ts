import { apiPost } from "@/lib/auth/client";
import { offerPath, type OfferAction, type OfferResponse } from "@/lib/contracts/offers";

// Browser side of POST /api/conversations/{cid}/offer (CSRF header, lib/auth/client).

export function postOfferAction(cid: string, action: OfferAction): Promise<OfferResponse> {
  return apiPost<OfferResponse>(offerPath(cid), action);
}
