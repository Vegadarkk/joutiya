import type { RentalRequestEventView, RentalRequestView } from "@/lib/contracts/rental-requests";
import type { RentalRequestDoc, RentalRequestEventDoc } from "@/lib/db/schemas";

// What a participant sees of the conversation's booking request and of its system messages.

export function rentalRequestView(request: RentalRequestDoc, requestedByMe: boolean): RentalRequestView {
  return {
    id: request.id,
    status: request.status,
    requestedByMe,
    from: request.from,
    to: request.to,
    unit: request.unit ?? "day",
    pickup: request.pickup ?? null,
    blocked: request.blocked === true,
    updatedAt: request.updatedAt.getTime(),
  };
}

export function rentalRequestEventView(step: RentalRequestEventDoc, byMe: boolean): RentalRequestEventView {
  return { event: step.event, byMe, from: step.from, to: step.to, unit: step.unit ?? "day", pickup: step.pickup ?? null };
}
