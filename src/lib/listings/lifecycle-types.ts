import type { ListingStatus } from "@/lib/contracts/listings";
import type { ContentOpDoc, ListingDoc } from "@/lib/db/schemas";

// Types shared by lifecycle.ts (pure) and service.ts (server). The listing document type is
// re-exported so the lifecycle module imports nothing server-only at runtime (types only).

export type { ListingDoc };
export type PausedReason = NonNullable<ListingDoc["pausedReason"]>;
export type ContentOp = ContentOpDoc["op"];

/** A partial update of the listing: `null` deletes an optional field (repository convention). */
export type ListingFieldPatch = { [K in keyof ListingDoc]?: ListingDoc[K] | null };

/** Seller mails about a listing; approval, reminder and expiry are sent by the moderation queue and the jobs. */
export type MailTemplateForListing = "listingPublished" | "listingPendingReview" | "listingRejected" | "listingApproved" | "listingExpiringSoon" | "listingExpired";

export interface TransitionEffects {
  /** searchOutbox entry to write with the listing (null: the index is not concerned). */
  search: "upsert" | "delete" | null;
  /** contentOps entry (LCEN) with the actor's IP. */
  contentOp: { op: ContentOp; ip: string | undefined } | null;
  /** auditLogs action, e.g. "listing.publish". */
  audit: string | null;
  /** Revalidate the public listing and profile pages. */
  revalidate: boolean;
  /** Mail to the seller. */
  mail: MailTemplateForListing | null;
}

export interface TransitionResult {
  patch: ListingFieldPatch & { status: ListingStatus; version: number; updatedAt: Date };
  effects: TransitionEffects;
}
