import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, optionPrice, resolvePricingConfig } from "@/config/pricing";
import { walletStateAt } from "@/lib/db/repositories/wallets";
import type { WalletDoc } from "@/lib/db/schemas";
import { billingAccountId, optionPatch, walletSummary } from "@/lib/payments/options";

// Option prices by category tier, the listing patch of each option, whose wallet pays, and the
// plan credits that stop counting once their period ended (phase 7 design §3, §5).

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-02T10:00:00Z");

describe("option prices", () => {
  it("charges vehicles and real estate the higher tier (spec §8)", () => {
    expect(optionPrice("bump", "electronique")).toBe(10);
    expect(optionPrice("bump", "vehicules")).toBe(20);
    expect(optionPrice("featured7", "immobilier")).toBe(59);
    expect(optionPrice("featured30", "mode")).toBe(79);
    expect(optionPrice("featured30", "vehicules")).toBe(149);
    expect(optionPrice("featured7", undefined)).toBe(29);
  });

  it("reads the prices from config/pricing and falls back on an invalid document", () => {
    const options = { ...DEFAULT_PRICING.options, bump: { standard: 12, premiumCat: 24 } };
    expect(optionPrice("bump", "vehicules", resolvePricingConfig({ options }).config)).toBe(24);
    const invalid = resolvePricingConfig({ options: { ...options, bump: { standard: 0, premiumCat: 24 } } });
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(optionPrice("bump", "electronique", invalid.config)).toBe(10);
  });
});

describe("listing patch", () => {
  it("bumps to the top with the bump mention", () => {
    expect(optionPatch({ boosts: {} }, "bump", now)).toEqual({ boosts: { bumpedAt: now }, sortAt: now, sortSource: "bump" });
  });

  it("adds À la Une days from now, or from the running end, without touching the sort", () => {
    expect(optionPatch({ boosts: {} }, "featured7", now)).toEqual({ boosts: { featuredUntil: new Date(now.getTime() + 7 * DAY_MS) } });
    const running = new Date(now.getTime() + 3 * DAY_MS);
    expect(optionPatch({ boosts: { featuredUntil: running, bumpedAt: now } }, "featured30", now)).toEqual({ boosts: { featuredUntil: new Date(running.getTime() + 30 * DAY_MS), bumpedAt: now } });
    const ended = new Date(now.getTime() - DAY_MS);
    expect(optionPatch({ boosts: { featuredUntil: ended } }, "featured7", now)).toEqual({ boosts: { featuredUntil: new Date(now.getTime() + 7 * DAY_MS) } });
  });
});

describe("wallets", () => {
  it("bills a shop's listing to the shop and anything else to its owner", () => {
    expect(billingAccountId({ ownerUid: "u1" })).toBe("u1");
    expect(billingAccountId({ ownerUid: "u1", proId: "shep2345" })).toBe("pro_shep2345");
  });

  const wallet: WalletDoc = {
    balance: 40,
    frozen: false,
    planCredits: 30,
    planCreditsResetsAt: new Date(now.getTime() + DAY_MS),
    allowances: { featured: 2, resetsAt: new Date(now.getTime() + DAY_MS) },
    createdAt: now,
    updatedAt: now,
  };

  it("counts the plan's credits and allowance until their period ends (not cumulative)", () => {
    expect(walletStateAt(null, now)).toEqual({ balance: 0, frozen: false, planCredits: 0, featuredAllowance: 0 });
    expect(walletStateAt(wallet, now)).toEqual({ balance: 40, frozen: false, planCredits: 30, featuredAllowance: 2 });
    const later = new Date(now.getTime() + 2 * DAY_MS);
    expect(walletStateAt(wallet, later)).toEqual({ balance: 40, frozen: false, planCredits: 0, featuredAllowance: 0 });
    expect(walletSummary(wallet, later)).toEqual({ balance: 40, planCredits: 0, planCreditsResetsAt: null, featuredAllowance: 0, frozen: false });
  });

  it("shows a negative balance as frozen", () => {
    expect(walletSummary({ ...wallet, balance: -5, frozen: false }, now).frozen).toBe(true);
  });
});
