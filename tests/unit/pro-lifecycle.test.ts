import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, launchOfferOpen, pricingConfigSchema, resolvePricingConfig } from "@/config/pricing";
import {
  IllegalProTransitionError,
  PRO_STATES,
  TRANSITIONS,
  canTransition,
  publishesAsPro,
  storefrontShown,
  transition,
  type ProEvent,
  type ProLifecycleView,
  type ProState,
} from "@/lib/pro/lifecycle";

// Pro status machine (architecture §5, phase 7 design §4) with the launch offer (owner decision
// Q13, 2026-10-16). Pure module: no Firestore.

const NOW = new Date("2026-10-16T10:00:00.000Z");
const ctx = { now: NOW, graceDays: 7 };

function pro(lifecycle: ProState, extra: Partial<ProLifecycleView> = {}): ProLifecycleView {
  return { lifecycle, plan: "none", planSource: "none", ...extra };
}

const ALL_EVENTS: ProEvent[] = [
  { type: "kybc_verified", launchOfferActive: true },
  { type: "kybc_verified", launchOfferActive: false },
  { type: "kybc_rejected" },
  { type: "reapplied" },
  { type: "subscription_active", plan: "essentiel" },
  { type: "billing_issue" },
  { type: "subscription_expired" },
  { type: "grace_ended" },
  { type: "launch_offer_ended" },
  { type: "pass_purchased", plan: "essentiel" },
  { type: "pass_ended" },
  { type: "suspended" },
  { type: "reinstated" },
];

describe("Pro lifecycle table", () => {
  it("covers every state and never allows an unknown target", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...PRO_STATES].sort());
    for (const from of PRO_STATES) for (const to of TRANSITIONS[from]) expect(PRO_STATES).toContain(to);
  });

  it("only produces transitions listed in the table", () => {
    for (const state of PRO_STATES) {
      for (const event of ALL_EVENTS) {
        const view = pro(state, { suspendedFrom: state === "suspended" ? "active" : undefined, planSource: state === "verified" ? "launch_offer" : "none" });
        try {
          const { patch } = transition(view, event, ctx);
          expect(canTransition(state, patch.lifecycle)).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(IllegalProTransitionError);
        }
      }
    }
  });
});

describe("verification", () => {
  it("gives the launch offer (Essentiel, storefront) while it is open", () => {
    const { patch, effects } = transition(pro("pending_verification"), { type: "kybc_verified", launchOfferActive: true }, ctx);
    expect(patch).toEqual({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer" });
    expect(effects).toMatchObject({ grantProClaims: true, retagListings: true, reindexListings: true, storefrontVisible: true, pauseOverQuota: false });
  });

  it("gives the `none` plan once the offer is closed", () => {
    const { patch, effects } = transition(pro("pending_verification"), { type: "kybc_verified", launchOfferActive: false }, ctx);
    expect(patch).toEqual({ lifecycle: "verified", plan: "none", planSource: "none" });
    expect(effects.grantProClaims).toBe(true);
    expect(effects.storefrontVisible).toBe(false);
  });

  it("rejects, then accepts a new application", () => {
    const rejected = transition(pro("pending_verification"), { type: "kybc_rejected" }, ctx);
    expect(rejected.patch.lifecycle).toBe("rejected");
    expect(rejected.effects.grantProClaims).toBe(false);
    expect(transition(pro("rejected"), { type: "reapplied" }, ctx).patch.lifecycle).toBe("pending_verification");
  });

  it("refuses a second verification", () => {
    expect(() => transition(pro("verified"), { type: "kybc_verified", launchOfferActive: true }, ctx)).toThrow(IllegalProTransitionError);
  });
});

describe("subscription", () => {
  it("activates from the launch offer and from a downgrade", () => {
    for (const from of ["verified", "downgraded"] as const) {
      const { patch, effects } = transition(pro(from, { planSource: from === "verified" ? "launch_offer" : "none" }), { type: "subscription_active", plan: "business" }, ctx);
      expect(patch).toEqual({ lifecycle: "active", plan: "business", planSource: "subscription", graceUntil: null });
      expect(effects.storefrontVisible).toBe(true);
      expect(effects.pauseOverQuota).toBe(false);
    }
  });

  it("pauses what no longer fits on a plan change", () => {
    const { patch, effects } = transition(pro("active", { plan: "business", planSource: "subscription" }), { type: "subscription_active", plan: "essentiel" }, ctx);
    expect(patch.plan).toBe("essentiel");
    expect(effects.pauseOverQuota).toBe(true);
  });

  it("enters grace for graceDays, keeps the plan, and recovers", () => {
    const grace = transition(pro("active", { plan: "essentiel", planSource: "subscription" }), { type: "billing_issue" }, ctx);
    expect(grace.patch).toEqual({ lifecycle: "grace", plan: "essentiel", planSource: "subscription", graceUntil: new Date("2026-10-23T10:00:00.000Z") });
    const back = transition(pro("grace", { plan: "essentiel", planSource: "subscription" }), { type: "subscription_active", plan: "essentiel" }, ctx);
    expect(back.patch.lifecycle).toBe("active");
    expect(back.patch.graceUntil).toBeNull();
  });

  it("downgrades on expiry or end of grace: quotas `none`, listings paused, storefront hidden", () => {
    for (const [from, type] of [["active", "subscription_expired"], ["grace", "grace_ended"], ["grace", "subscription_expired"]] as const) {
      const { patch, effects } = transition(pro(from, { plan: "business", planSource: "subscription" }), { type }, ctx);
      expect(patch).toEqual({ lifecycle: "downgraded", plan: "none", planSource: "none", graceUntil: null, downgradedAt: NOW });
      expect(effects).toMatchObject({ pauseOverQuota: true, storefrontVisible: false, grantProClaims: false });
    }
  });

  it("does not let a billing issue hit a Pro without a subscription", () => {
    expect(() => transition(pro("verified", { plan: "essentiel", planSource: "launch_offer" }), { type: "billing_issue" }, ctx)).toThrow(IllegalProTransitionError);
  });
});

describe("launch offer end", () => {
  it("downgrades a Pro still on the offer", () => {
    const { patch, effects } = transition(pro("verified", { plan: "essentiel", planSource: "launch_offer" }), { type: "launch_offer_ended" }, ctx);
    expect(patch.lifecycle).toBe("downgraded");
    expect(patch.plan).toBe("none");
    expect(effects.pauseOverQuota).toBe(true);
  });

  it("leaves subscribed Pros and Pros outside the offer alone", () => {
    expect(() => transition(pro("active", { plan: "essentiel", planSource: "subscription" }), { type: "launch_offer_ended" }, ctx)).toThrow(IllegalProTransitionError);
    expect(() => transition(pro("verified", { plan: "none", planSource: "none" }), { type: "launch_offer_ended" }, ctx)).toThrow(IllegalProTransitionError);
  });
});

describe("suspension", () => {
  it("remembers the previous state and restores it", () => {
    const suspended = transition(pro("active", { plan: "business", planSource: "subscription" }), { type: "suspended" }, ctx);
    expect(suspended.patch).toEqual({ lifecycle: "suspended", plan: "business", planSource: "subscription", suspendedFrom: "active" });
    expect(suspended.effects).toMatchObject({ suspend: true, storefrontVisible: false });
    const back = transition(pro("suspended", { plan: "business", planSource: "subscription", suspendedFrom: "active" }), { type: "reinstated" }, ctx);
    expect(back.patch).toEqual({ lifecycle: "active", plan: "business", planSource: "subscription", suspendedFrom: null });
    expect(back.effects).toMatchObject({ suspend: false, storefrontVisible: true });
  });

  it("refuses a reinstatement without a known previous state", () => {
    expect(() => transition(pro("suspended"), { type: "reinstated" }, ctx)).toThrow(IllegalProTransitionError);
  });
});

describe("helpers", () => {
  it("knows who publishes as a Pro and who has a storefront", () => {
    expect(PRO_STATES.filter(publishesAsPro).sort()).toEqual(["active", "downgraded", "grace", "verified"]);
    expect(storefrontShown("verified", "essentiel")).toBe(true);
    expect(storefrontShown("verified", "none")).toBe(false);
    expect(storefrontShown("downgraded", "none")).toBe(false);
    expect(storefrontShown("suspended", "business")).toBe(false);
  });
});

describe("Pass Boutique", () => {
  it("activates the pass's plan from a verified or downgraded shop, and keeps an active pass", () => {
    for (const from of ["verified", "downgraded"] as const) {
      const { patch, effects } = transition(pro(from), { type: "pass_purchased", plan: "essentiel" }, ctx);
      expect(patch).toEqual({ lifecycle: "active", plan: "essentiel", planSource: "pass", graceUntil: null });
      expect(effects).toMatchObject({ storefrontVisible: true, reindexListings: true, pauseOverQuota: false });
    }
    expect(transition(pro("active", { plan: "essentiel", planSource: "pass" }), { type: "pass_purchased", plan: "essentiel" }, ctx).patch.planSource).toBe("pass");
  });

  it("never doubles a subscription, and waits for a suspended or unverified shop", () => {
    for (const view of [pro("active", { plan: "essentiel", planSource: "subscription" }), pro("grace", { plan: "essentiel", planSource: "subscription" }), pro("suspended", { suspendedFrom: "active" }), pro("pending_verification"), pro("rejected")]) {
      expect(() => transition(view, { type: "pass_purchased", plan: "essentiel" }, ctx)).toThrow(IllegalProTransitionError);
    }
  });

  it("downgrades at the end of a pass without grace, and only a pass", () => {
    const { patch, effects } = transition(pro("active", { plan: "essentiel", planSource: "pass" }), { type: "pass_ended" }, ctx);
    expect(patch).toEqual({ lifecycle: "downgraded", plan: "none", planSource: "none", graceUntil: null, downgradedAt: NOW });
    expect(effects).toMatchObject({ pauseOverQuota: true, storefrontVisible: false });
    expect(() => transition(pro("active", { plan: "essentiel", planSource: "subscription" }), { type: "pass_ended" }, ctx)).toThrow(IllegalProTransitionError);
    expect(() => transition(pro("verified", { plan: "essentiel", planSource: "launch_offer" }), { type: "pass_ended" }, ctx)).toThrow(IllegalProTransitionError);
  });

  it("shows the storefront during a pass", () => {
    expect(storefrontShown("active", "essentiel")).toBe(true);
  });

  it("sells a 30-day Essentiel pass at 249 MAD HT by default and refuses a pass longer than its limit", () => {
    expect(DEFAULT_PRICING.passes).toEqual([{ id: "boutique30", plan: "essentiel", days: 30, priceMinor: 24_900, credits: 30, maxAheadDays: 90 }]);
    expect(resolvePricingConfig({ passes: [{ ...DEFAULT_PRICING.passes[0], days: 120, maxAheadDays: 90 }] }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ passes: [DEFAULT_PRICING.passes[0], DEFAULT_PRICING.passes[0]] }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ passes: [{ ...DEFAULT_PRICING.passes[0], stripePrice: "prod_1" }] }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ passes: [{ ...DEFAULT_PRICING.passes[0], stripePrice: "price_1" }] }).config.passes[0]?.stripePrice).toBe("price_1");
    // A stored config/pricing written before passes existed keeps the default pass.
    expect(resolvePricingConfig({ graceDays: 7 }).config.passes).toEqual(DEFAULT_PRICING.passes);
  });
});

describe("launch offer config", () => {
  it("defaults to an open Essentiel offer with 30 days' notice", () => {
    expect(DEFAULT_PRICING.launchOffer).toEqual({ active: true, plan: "essentiel", noticeDays: 30, endsAt: null });
    expect(pricingConfigSchema.safeParse(DEFAULT_PRICING).success).toBe(true);
  });

  it("is open until endsAt, closed when inactive", () => {
    const offer = { ...DEFAULT_PRICING.launchOffer, endsAt: "2026-11-15T00:00:00.000Z" };
    expect(launchOfferOpen(DEFAULT_PRICING.launchOffer, NOW)).toBe(true);
    expect(launchOfferOpen(offer, NOW)).toBe(true);
    expect(launchOfferOpen(offer, new Date("2026-11-15T00:00:00.000Z"))).toBe(false);
    expect(launchOfferOpen({ ...offer, active: false }, NOW)).toBe(false);
  });

  it("rejects a malformed stored offer and keeps the defaults", () => {
    const { config, errors } = resolvePricingConfig({ launchOffer: { active: true, plan: "premium", noticeDays: 30, endsAt: null } });
    expect(config).toBe(DEFAULT_PRICING);
    expect(errors.some((e) => e.startsWith("launchOffer.plan"))).toBe(true);
  });
});
