import "server-only";
import type { QuotaId } from "@/config/quotas";
import { HttpError, type ErrorCode } from "@/lib/http/errors";
import { firstDegraded, nextReset } from "./index";

// App-side degraded modes of the Firestore quotas (§2 "Garde-fous de quotas", `degradedMode` in
// src/config/quotas.ts). At 100 % Spark answers RESOURCE_EXHAUSTED until its daily reset: a route
// that needs the quota refuses up front with a 503 and a Retry-After set to that reset, instead of
// failing half-way (an Auth record without its documents, a 500 in the wizard). Reports stay open.
// Unknown counters (Valkey down) count as available, like everywhere else.

/**
 * Listing deposit: create, edit, publish, renew and resume, photo uploads ("Dépôt d'annonces
 * suspendu"). Not firestore.storage: nothing measures it on Spark, and it does not reset at night
 * (a full store would need its own code and message, like storage_full for R2).
 */
export const DEPOSIT_QUOTAS = ["firestore.writes"] as const satisfies readonly QuotaId[];

/** New account (password or Google): three documents, then the connection log. */
export const SIGNUP_QUOTAS = ["firestore.writes"] as const satisfies readonly QuotaId[];

/**
 * Public pages rendered from Firestore: the loader throws once reads are degraded, so ISR keeps
 * serving the last page it generated ("pages annonce depuis le cache ISR").
 */
export const PUBLIC_READ_QUOTAS = ["firestore.reads"] as const satisfies readonly QuotaId[];

/**
 * API code of a refusal: its own code, so clients neither retry it like a transient "unavailable"
 * nor show a generic error. Auth.errors and Listing.errors (messages/*.json) say to retry after
 * 9 h, Morocco time (the Pacific midnight is 07:00 to 09:00 there).
 */
export const QUOTA_ERROR_CODE: ErrorCode = "quota_exhausted";

/** Never below a minute: a refusal just before the reset must not invite a tight retry loop. */
const MIN_RETRY_SECONDS = 60;

/** Seconds until the provider resets `id` (Retry-After). */
export function retryAfterSeconds(id: QuotaId, at = new Date()): number {
  return Math.max(MIN_RETRY_SECONDS, Math.ceil((nextReset(id, at).getTime() - at.getTime()) / 1000));
}

/** 503 for a degraded quota, retryable at the provider's reset. */
export function quotaUnavailable(id: QuotaId, at = new Date()): HttpError {
  return new HttpError(503, QUOTA_ERROR_CODE, "daily quota reached, retry after the reset", { headers: { "Retry-After": String(retryAfterSeconds(id, at)) } });
}

/** Throws quotaUnavailable for the first degraded quota of `ids`; one Valkey round trip. */
export async function assertQuotas(ids: readonly QuotaId[]): Promise<void> {
  const degraded = await firstDegraded(ids);
  if (degraded) throw quotaUnavailable(degraded);
}

/** gRPC status of a Spark refusal (google.rpc.Code RESOURCE_EXHAUSTED), as the Admin SDK reports it. */
const RESOURCE_EXHAUSTED = 8;

/**
 * True when Firestore refused the call because a daily quota is spent: the counters missed some
 * usage (client-side reads, retried transactions). Batch jobs stop on it like on a degraded quota.
 */
export function isResourceExhausted(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === RESOURCE_EXHAUSTED;
}

/**
 * The same 503 as a degraded quota for a Firestore refusal (reads, writes and deletes all reset at
 * the Pacific midnight), or null for any other error: for the API route wrapper.
 */
export function fromResourceExhausted(error: unknown, at = new Date()): HttpError | null {
  return isResourceExhausted(error) ? quotaUnavailable("firestore.writes", at) : null;
}
