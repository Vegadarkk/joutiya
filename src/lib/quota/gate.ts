import "server-only";
import type { QuotaId } from "@/config/quotas";
import { HttpError, type ErrorCode } from "@/lib/http/errors";
import { firstDegraded, nextReset } from "./index";

// App-side degraded modes of the Firestore quotas (§2 "Garde-fous de quotas", `degradedMode` in
// src/config/quotas.ts). At 100 % Spark answers RESOURCE_EXHAUSTED until its daily reset: a route
// that needs the quota refuses up front with a 503 and a Retry-After set to that reset, instead of
// failing half-way (an Auth record without its documents, a 500 in the wizard). Reports stay open.
// Unknown counters (Valkey down) count as available, like everywhere else.

/** Listing deposit: create, edit, publish, renew, photo uploads ("Dépôt d'annonces suspendu"). */
export const DEPOSIT_QUOTAS = ["firestore.writes", "firestore.storage"] as const satisfies readonly QuotaId[];

/** New account (password or Google): three documents, then the connection log. */
export const SIGNUP_QUOTAS = ["firestore.writes"] as const satisfies readonly QuotaId[];

/**
 * Public pages rendered from Firestore: the loader throws once reads are degraded, so ISR keeps
 * serving the last page it generated ("pages annonce depuis le cache ISR").
 */
export const PUBLIC_READ_QUOTAS = ["firestore.reads"] as const satisfies readonly QuotaId[];

/** API code of a refusal (the client shows the matching Listing.errors or Auth.errors message). */
export const QUOTA_ERROR_CODE: ErrorCode = "unavailable";

/** At least a minute: a gauge measured at its reset may still be full. */
const MIN_RETRY_SECONDS = 60;

/** Seconds until the provider resets `id` (Retry-After). */
export function retryAfterSeconds(id: QuotaId, at = new Date()): number {
  return Math.max(MIN_RETRY_SECONDS, Math.ceil((nextReset(id, at).getTime() - at.getTime()) / 1000));
}

/** 503 for a degraded quota, retryable at the provider's reset. */
export function quotaUnavailable(id: QuotaId, at = new Date()): HttpError {
  return new HttpError(503, QUOTA_ERROR_CODE, `${id} quota degraded until its reset`, { headers: { "Retry-After": String(retryAfterSeconds(id, at)) } });
}

/** Throws quotaUnavailable for the first degraded quota of `ids`; one Valkey round trip. */
export async function assertQuotas(ids: readonly QuotaId[]): Promise<void> {
  const degraded = await firstDegraded(ids);
  if (degraded) throw quotaUnavailable(degraded);
}
