import type { ListingStatus } from "@/lib/contracts/listings";
import type { ListingDoc, PausedReason } from "./lifecycle-types";
import type { ContentOp, MailTemplateForListing, TransitionEffects, TransitionResult } from "./lifecycle-types";

// Listing status machine (architecture §5 "Cycle de vie d'une annonce", design D16). Pure: the
// transition returns the field patch and the side effects; service.ts writes them (Firestore
// transaction, searchOutbox, contentOps, audit, revalidation, mail). No server import so the unit
// tests and, if ever needed, the wizard can read the table.

export type { ListingFieldPatch, TransitionEffects, TransitionResult } from "./lifecycle-types";

// `-> pending_review` from published, paused or expired: an edit (or an expired listing's renewal)
// held by the pre-moderation. `-> purged`: the retention purge at purgeAt (§5: expiry, sale or
// removal + 12 months; a moderator's rejection is a removal, its purgeAt is set the same way).
export const TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ["pending_review", "published", "removed"],
  pending_review: ["published", "rejected", "removed"],
  published: ["paused", "sold", "expired", "removed", "pending_review"],
  paused: ["published", "sold", "expired", "removed", "pending_review"],
  sold: ["removed", "expired", "purged"],
  expired: ["published", "removed", "purged", "pending_review"],
  rejected: ["draft", "removed", "purged"],
  removed: ["purged"],
  purged: [],
};

/** A published listing may be renewed when fewer than this many days are left (D16). */
export const RENEW_WINDOW_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export function addMonths(from: Date, months: number): Date {
  const date = new Date(from.getTime());
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

export interface Lifetime {
  ttlDays: number;
  purgeMonths: number;
}

export function expiresAtFor(publishedAt: Date, lifetime: Lifetime): Date {
  return addDays(publishedAt, lifetime.ttlDays);
}

export function purgeAtFor(from: Date, lifetime: Lifetime): Date {
  return addMonths(from, lifetime.purgeMonths);
}

export function canTransition(from: ListingStatus, to: ListingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionContext {
  now: Date;
  lifetime: Lifetime;
  /** Pause reason (owner by default; "quota" when a Pro downgrade pauses listings). */
  pausedReason?: PausedReason;
  /** Clear IP of the actor, forwarded to the contentOps entry (undefined for system transitions). */
  ip?: string;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ListingStatus,
    readonly to: ListingStatus,
    reason?: string,
  ) {
    super(reason ?? `${from} -> ${to} is not allowed`);
    this.name = "IllegalTransitionError";
  }
}

/** Fewer than RENEW_WINDOW_DAYS left on a published listing, or expired and not purged yet. */
export function canRenew(listing: Pick<ListingDoc, "status" | "expiresAt" | "purgeAt">, now: Date): boolean {
  if (listing.status === "expired") return !listing.purgeAt || now.getTime() < listing.purgeAt.getTime();
  if (listing.status === "published") return listing.expiresAt !== undefined && listing.expiresAt.getTime() - now.getTime() < RENEW_WINDOW_DAYS * DAY_MS;
  return false;
}

const NO_EFFECTS: TransitionEffects = { search: null, contentOp: null, audit: null, revalidate: false, mail: null };

function effects(partial: Partial<TransitionEffects>): TransitionEffects {
  return { ...NO_EFFECTS, ...partial };
}

type Listing = Pick<ListingDoc, "status" | "version" | "publishedAt" | "expiresAt" | "purgeAt" | "pausedReason" | "sortAt" | "sortSource">;

/**
 * Field patch and side effects of `listing` going to `to`. Throws IllegalTransitionError when the
 * table forbids it (or when a resume comes after expiry). `version` and `updatedAt` are always
 * part of the patch; `null` deletes an optional field.
 */
export function transition(listing: Listing, to: ListingStatus, ctx: TransitionContext): TransitionResult {
  const from = listing.status;
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  const { now, lifetime } = ctx;
  const base = { version: listing.version + 1, updatedAt: now } as const;
  const contentOp = (op: ContentOp) => ({ op, ip: ctx.ip });

  switch (to) {
    case "published": {
      if (from === "paused") {
        // Resume: only before expiry (D16); the original dates stay.
        if (!listing.expiresAt || listing.expiresAt.getTime() <= now.getTime()) throw new IllegalTransitionError(from, to, "paused listing already expired");
        return {
          patch: { ...base, status: "published", pausedReason: null },
          effects: effects({ search: "upsert", contentOp: contentOp("listing.update"), audit: "listing.resume", revalidate: true }),
        };
      }
      if (from === "expired") {
        // Renew after expiry: back on top of the list with a fresh lifetime.
        if (listing.purgeAt && now.getTime() >= listing.purgeAt.getTime()) throw new IllegalTransitionError(from, to, "listing already purgeable");
        return renewPatch(listing, now, lifetime, ctx.ip);
      }
      if (from === "pending_review" && listing.publishedAt) {
        // Approval of a held edit (or held renewal) of a listing published before: its dates stay;
        // only an expiry that passed meanwhile gets a fresh lifetime.
        const lapsed = !listing.expiresAt || listing.expiresAt.getTime() <= now.getTime();
        const expiresAt = expiresAtFor(now, lifetime);
        return {
          patch: { ...base, status: "published", pausedReason: null, ...(lapsed ? { expiresAt, purgeAt: purgeAtFor(expiresAt, lifetime) } : {}) },
          effects: effects({ search: "upsert", contentOp: contentOp("listing.update"), audit: "listing.approve", revalidate: true }),
        };
      }
      // Publish (from draft) or approve a held publication (from pending_review).
      const expiresAt = expiresAtFor(now, lifetime);
      return {
        patch: { ...base, status: "published", publishedAt: now, expiresAt, purgeAt: purgeAtFor(expiresAt, lifetime), sortAt: now, sortSource: "publish", pausedReason: null },
        effects: effects({
          search: "upsert",
          contentOp: contentOp("listing.publish"),
          audit: from === "draft" ? "listing.publish" : "listing.approve",
          revalidate: true,
          mail: from === "draft" ? "listingPublished" : null,
        }),
      };
    }
    case "pending_review": {
      if (from === "draft") {
        // Publish held by the pre-moderation: dated like a publication, not indexed, seller told.
        // Not published yet (a reopened rejected listing drops its old date): the approval dates it.
        return {
          patch: { ...base, status: "pending_review", sortAt: now, sortSource: "publish", publishedAt: null },
          effects: effects({ contentOp: contentOp("listing.publish"), audit: "listing.publish", mail: "listingPendingReview" }),
        };
      }
      // An edit of a live, paused or expired listing raised a flag: off the index and the public
      // page until a moderator looks.
      return {
        patch: { ...base, status: "pending_review" },
        effects: effects({ search: "delete", contentOp: contentOp("listing.update"), audit: "listing.hold", revalidate: true, mail: "listingPendingReview" }),
      };
    }
    case "paused":
      return {
        patch: { ...base, status: "paused", pausedReason: ctx.pausedReason ?? "owner" },
        effects: effects({ search: "delete", contentOp: contentOp("listing.update"), audit: "listing.pause", revalidate: true }),
      };
    case "sold":
      // Sold keeps expiresAt (D16); the purge clock starts now (§5: sale + purge months).
      return {
        patch: { ...base, status: "sold", purgeAt: purgeAtFor(now, lifetime) },
        effects: effects({ search: "delete", contentOp: contentOp("listing.update"), audit: "listing.sold", revalidate: true }),
      };
    case "expired":
      return {
        patch: { ...base, status: "expired", purgeAt: purgeAtFor(now, lifetime) },
        effects: effects({ search: "delete", audit: "listing.expire", revalidate: true }),
      };
    case "removed":
      return {
        patch: { ...base, status: "removed", purgeAt: purgeAtFor(now, lifetime) },
        effects: effects({ search: from === "published" ? "delete" : null, contentOp: contentOp("listing.remove"), audit: "listing.remove", revalidate: from !== "draft" }),
      };
    case "rejected":
      return {
        patch: { ...base, status: "rejected", purgeAt: purgeAtFor(now, lifetime) },
        effects: effects({ search: "delete", audit: "listing.reject", revalidate: true, mail: "listingRejected" }),
      };
    case "draft":
      // Rejected listing edited again: back to the wizard, purge clock stopped.
      return { patch: { ...base, status: "draft", purgeAt: null }, effects: effects({ audit: "listing.edit" }) };
    case "purged":
      return { patch: { ...base, status: "purged" }, effects: effects({ search: "delete", audit: "listing.purge", revalidate: true }) };
  }
}

function renewPatch(listing: Listing, now: Date, lifetime: Lifetime, ip: string | undefined): TransitionResult {
  const expiresAt = expiresAtFor(now, lifetime);
  return {
    patch: { version: listing.version + 1, updatedAt: now, status: "published", sortAt: now, sortSource: "renew", expiresAt, purgeAt: purgeAtFor(expiresAt, lifetime), pausedReason: null },
    effects: effects({ search: "upsert", contentOp: { op: "listing.update", ip }, audit: "listing.renew", revalidate: true }),
  };
}

/**
 * Renewal (D16): expired before purge, or published with fewer than 7 days left. `sortAt = now`,
 * `sortSource = "renew"`, new `expiresAt`. A published listing renews in place (published ->
 * published is not a table transition; this is the one same-status change).
 */
export function renew(listing: Listing, ctx: TransitionContext): TransitionResult {
  if (!canRenew(listing, ctx.now)) throw new IllegalTransitionError(listing.status, "published", "listing cannot be renewed yet");
  return renewPatch(listing, ctx.now, ctx.lifetime, ctx.ip);
}

/**
 * Renewal of an expired listing that the pre-moderation holds: pending_review, back on top
 * (`sortAt`, `sortSource = "renew"`); the approval gives the new `expiresAt` (its expiry passed).
 */
export function renewForReview(listing: Listing, ctx: TransitionContext): TransitionResult {
  if (listing.status !== "expired" || !canRenew(listing, ctx.now)) throw new IllegalTransitionError(listing.status, "pending_review", "listing cannot be renewed");
  const held = transition(listing, "pending_review", ctx);
  return { patch: { ...held.patch, sortAt: ctx.now, sortSource: "renew" }, effects: { ...held.effects, audit: "listing.renew" } };
}

export type { MailTemplateForListing };
