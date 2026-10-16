import type { ProPlan } from "@/config/pricing";

// Pro account status machine (architecture §5 "Cycle de vie d'un compte Pro", phase 7 design §4).
// Pure: a transition returns the profile patch and the side effects; the Pro service applies them
// (Firestore transaction, claims and token revocation, listing retag or pause, search outbox,
// audit, mail). No server import so the unit tests and the admin UI can read the table.
//
// Launch offer (owner decision Q13, 2026-10-16): while sales are closed, a verified Pro gets the
// Essentiel quotas and storefront for free, without monthly credits (`planSource: "launch_offer"`).
// When the offer ends (30 days' notice after sales open), a Pro without a subscription is
// downgraded like a Pro whose subscription expired.

export const PRO_STATES = ["pending_verification", "verified", "active", "grace", "downgraded", "rejected", "suspended"] as const;
export type ProState = (typeof PRO_STATES)[number];

export const PLAN_SOURCES = ["launch_offer", "subscription", "none"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export type PaidPlan = Exclude<ProPlan, "none">;

export const TRANSITIONS: Record<ProState, readonly ProState[]> = {
  pending_verification: ["verified", "rejected", "suspended"],
  verified: ["active", "downgraded", "suspended"],
  active: ["active", "grace", "downgraded", "suspended"],
  grace: ["active", "downgraded", "suspended"],
  downgraded: ["active", "suspended"],
  rejected: ["pending_verification", "suspended"],
  suspended: ["pending_verification", "verified", "active", "grace", "downgraded", "rejected"],
};

export type ProEvent =
  /** A moderator validated the KYBC; `launchOfferActive` comes from `config/pricing.launchOffer`. */
  | { type: "kybc_verified"; launchOfferActive: boolean }
  | { type: "kybc_rejected" }
  /** New application after a rejection. */
  | { type: "reapplied" }
  /** `subscriptions/pro_{proId}` became active (first purchase, renewal after downgrade, plan change). */
  | { type: "subscription_active"; plan: PaidPlan }
  /** `BILLING_ISSUE` or a failed Stripe payment. */
  | { type: "billing_issue" }
  | { type: "subscription_expired" }
  /** `graceUntil` passed without a payment. */
  | { type: "grace_ended" }
  /** `config/pricing.launchOffer.endsAt` passed and the Pro has no subscription. */
  | { type: "launch_offer_ended" }
  | { type: "suspended" }
  /** Suspension lifted (appeal granted or term over): back to the state held before. */
  | { type: "reinstated" };

export interface ProLifecycleView {
  lifecycle: ProState;
  plan: ProPlan;
  planSource: PlanSource;
  graceUntil?: Date;
  /** State held when the suspension started, restored by `reinstated`. */
  suspendedFrom?: ProState;
}

export interface ProPatch {
  lifecycle: ProState;
  plan: ProPlan;
  planSource: PlanSource;
  /** `null` clears the field. */
  graceUntil?: Date | null;
  downgradedAt?: Date;
  suspendedFrom?: ProState | null;
}

export interface ProEffects {
  /** Set claims `role: "pro"`, `proId`, `proRole: "owner"` and revoke refresh tokens (§6). */
  grantProClaims: boolean;
  /** Existing listings of the account move to `sellerType: "pro"` and are reindexed. */
  retagListings: boolean;
  /** Pause the listings above the new quota, oldest `sortAt` first (`pausedReason: "quota"`). */
  pauseOverQuota: boolean;
  /** Storefront and Certifié badge shown (true) or hidden (false); undefined = unchanged. */
  storefrontVisible?: boolean;
  /** Listings hidden from search and purchases frozen (suspension), or restored. */
  suspend?: boolean;
  /** Reindex the account's listings (seller badge, visibility). */
  reindexListings: boolean;
}

export interface ProTransitionResult {
  patch: ProPatch;
  effects: ProEffects;
}

export interface ProTransitionContext {
  now: Date;
  graceDays: number;
}

export class IllegalProTransitionError extends Error {
  constructor(
    readonly from: ProState,
    readonly event: ProEvent["type"],
  ) {
    super(`${event} is not allowed from ${from}`);
    this.name = "IllegalProTransitionError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

const NO_EFFECTS: ProEffects = { grantProClaims: false, retagListings: false, pauseOverQuota: false, reindexListings: false };

export function canTransition(from: ProState, to: ProState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which the Pro publishes with the quotas of `plan` (verified on launch offer included). */
export function publishesAsPro(state: ProState): boolean {
  return state === "verified" || state === "active" || state === "grace" || state === "downgraded";
}

/** Next state for an event, or an `IllegalProTransitionError`. */
export function transition(current: ProLifecycleView, event: ProEvent, ctx: ProTransitionContext): ProTransitionResult {
  const from = current.lifecycle;
  const result = apply(current, event, ctx);
  if (!result || !canTransition(from, result.patch.lifecycle)) throw new IllegalProTransitionError(from, event.type);
  return result;
}

function apply(current: ProLifecycleView, event: ProEvent, ctx: ProTransitionContext): ProTransitionResult | null {
  const from = current.lifecycle;
  switch (event.type) {
    case "kybc_verified":
      if (from !== "pending_verification") return null;
      return {
        patch: event.launchOfferActive
          ? { lifecycle: "verified", plan: "essentiel", planSource: "launch_offer" }
          : { lifecycle: "verified", plan: "none", planSource: "none" },
        effects: { ...NO_EFFECTS, grantProClaims: true, retagListings: true, reindexListings: true, storefrontVisible: event.launchOfferActive },
      };
    case "kybc_rejected":
      if (from !== "pending_verification") return null;
      return { patch: { lifecycle: "rejected", plan: "none", planSource: "none" }, effects: NO_EFFECTS };
    case "reapplied":
      if (from !== "rejected") return null;
      return { patch: { lifecycle: "pending_verification", plan: "none", planSource: "none" }, effects: NO_EFFECTS };
    case "subscription_active":
      if (from !== "verified" && from !== "downgraded" && from !== "active" && from !== "grace") return null;
      return {
        patch: { lifecycle: "active", plan: event.plan, planSource: "subscription", graceUntil: null },
        // A plan change can lower the quota (Business -> Essentiel): pause what no longer fits.
        effects: { ...NO_EFFECTS, storefrontVisible: true, reindexListings: true, pauseOverQuota: from === "active" || from === "grace" },
      };
    case "billing_issue":
      if (from !== "active") return null;
      return {
        patch: { lifecycle: "grace", plan: current.plan, planSource: current.planSource, graceUntil: new Date(ctx.now.getTime() + ctx.graceDays * DAY_MS) },
        effects: NO_EFFECTS,
      };
    case "subscription_expired":
    case "grace_ended":
      if (from !== "active" && from !== "grace") return null;
      return downgrade(ctx);
    case "launch_offer_ended":
      if (from !== "verified" || current.planSource !== "launch_offer") return null;
      return downgrade(ctx);
    case "suspended":
      if (from === "suspended") return null;
      return {
        patch: { lifecycle: "suspended", plan: current.plan, planSource: current.planSource, suspendedFrom: from },
        effects: { ...NO_EFFECTS, suspend: true, storefrontVisible: false, reindexListings: true },
      };
    case "reinstated": {
      if (from !== "suspended" || !current.suspendedFrom || current.suspendedFrom === "suspended") return null;
      const back = current.suspendedFrom;
      return {
        patch: { lifecycle: back, plan: current.plan, planSource: current.planSource, suspendedFrom: null },
        effects: { ...NO_EFFECTS, suspend: false, storefrontVisible: storefrontShown(back, current.plan), reindexListings: true },
      };
    }
  }
}

function downgrade(ctx: ProTransitionContext): ProTransitionResult {
  return {
    patch: { lifecycle: "downgraded", plan: "none", planSource: "none", graceUntil: null, downgradedAt: ctx.now },
    // The `pro` role stays (art. L121-4 21° C. conso): only the quotas drop. Listings above the
    // `none` quota are paused, never republished automatically on a new subscription (§5).
    effects: { ...NO_EFFECTS, pauseOverQuota: true, storefrontVisible: false, reindexListings: true },
  };
}

/** Storefront and Certifié badge are shown for a verified Pro on a plan (subscription or launch offer). */
export function storefrontShown(state: ProState, plan: ProPlan): boolean {
  return (state === "verified" || state === "active" || state === "grace") && plan !== "none";
}
