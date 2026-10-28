import { describe, expect, it } from "vitest";
import {
  CLOSURE_LISTING_STATUSES,
  EXPORT_LIMITS,
  EXPORT_MAX_READS,
  EXPORT_MESSAGES_PER_CONVERSATION,
  accountPurgeVerdict,
  closureBlocker,
  closureDates,
  closurePurgeAt,
  identityPurgeable,
  isRecentSignIn,
  messageAllowances,
  statusAfterClosure,
} from "@/lib/account/rules";
import { RECENT_AUTH_SECONDS } from "@/lib/contracts/account";

// Account closure and export rules (phase 5 D26, lot L7; AF §5 UserPrivate, §7 retention table):
// the closure dates, the recent sign-in, the Pro refusal, the nightly purge verdicts and the export
// read budget. Pure functions; the API tests (tests/api/account) run them against the emulators.

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const PAST = new Date(NOW.getTime() - DAY);
const FUTURE = new Date(NOW.getTime() + DAY);

describe("closure dates and status", () => {
  it("purges the account data one year after the closure and the identity five years after", () => {
    const dates = closureDates(NOW);
    expect(dates.closedAt).toEqual(NOW);
    expect(dates.purgeAt.toISOString()).toBe("2027-10-20T10:00:00.000Z");
    expect(dates.identityPurgeAt.toISOString()).toBe("2031-10-20T10:00:00.000Z");
  });

  it("keeps a ban, closes any other status", () => {
    expect(statusAfterClosure("banned")).toBe("banned");
    for (const status of ["active", "restricted", "suspended", "closed"]) expect(statusAfterClosure(status)).toBe("closed");
  });

  it("asks for a sign-in younger than ten minutes", () => {
    const seconds = NOW.getTime() / 1000;
    expect(RECENT_AUTH_SECONDS).toBe(600);
    expect(isRecentSignIn(seconds - 30, NOW)).toBe(true);
    expect(isRecentSignIn(seconds - 600, NOW)).toBe(true);
    expect(isRecentSignIn(seconds - 601, NOW)).toBe(false);
    expect(isRecentSignIn(seconds - 14 * 86_400, NOW)).toBe(false);
    // A clock a few seconds ahead is fine; a sign-in "in the future" by minutes is not.
    expect(isRecentSignIn(seconds + 30, NOW)).toBe(true);
    expect(isRecentSignIn(seconds + 3600, NOW)).toBe(false);
    expect(isRecentSignIn(Number.NaN, NOW)).toBe(false);
  });

  it("takes off every listing a page, the search or a renewal still shows, never drafts or ended ones", () => {
    expect([...CLOSURE_LISTING_STATUSES].sort()).toEqual(["expired", "paused", "pending_review", "published", "sold"]);
  });

  it("never pushes a listing's purge date back", () => {
    const computed = new Date("2027-10-20T00:00:00Z");
    expect(closurePurgeAt(undefined, computed)).toEqual(computed);
    expect(closurePurgeAt(new Date("2027-01-01T00:00:00Z"), computed)).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(closurePurgeAt(new Date("2028-01-01T00:00:00Z"), computed)).toEqual(computed);
  });
});

describe("Pro refusal", () => {
  const none = { proProfile: null, subscriptions: [], wallets: [] };

  it("lets an individual without billing close", () => {
    expect(closureBlocker(none)).toBeNull();
    expect(closureBlocker({ ...none, wallets: [{ balance: 0 }, { balance: -12 }] })).toBeNull();
    expect(closureBlocker({ ...none, proProfile: { planSource: "launch_offer", lifecycle: "active" } })).toBeNull();
  });

  it("refuses while a subscription still renews", () => {
    for (const status of ["active", "grace", "billing_issue"]) expect(closureBlocker({ ...none, subscriptions: [{ status }] })).toBe("pro_subscription_active");
    // Cancelled (or not renewing): it runs out on its own.
    expect(closureBlocker({ ...none, subscriptions: [{ status: "active", willRenew: false }] })).toBeNull();
    for (const status of ["cancelled", "expired"]) expect(closureBlocker({ ...none, subscriptions: [{ status }] })).toBeNull();
  });

  it("reads the profile's plan only without a subscription document", () => {
    const paid = { planSource: "subscription", lifecycle: "active" };
    expect(closureBlocker({ ...none, proProfile: paid })).toBe("pro_subscription_active");
    expect(closureBlocker({ ...none, proProfile: { ...paid, lifecycle: "grace" } })).toBe("pro_subscription_active");
    expect(closureBlocker({ ...none, proProfile: { ...paid, lifecycle: "downgraded" } })).toBeNull();
    expect(closureBlocker({ ...none, proProfile: paid, subscriptions: [{ status: "cancelled" }] })).toBeNull();
  });

  it("refuses while purchased credits are left, after the subscription check", () => {
    expect(closureBlocker({ ...none, wallets: [{ balance: 0 }, { balance: 50 }] })).toBe("wallet_not_empty");
    expect(closureBlocker({ ...none, wallets: [{ balance: "50" }] })).toBeNull();
    expect(closureBlocker({ ...none, subscriptions: [{ status: "active" }], wallets: [{ balance: 50 }] })).toBe("pro_subscription_active");
  });
});

describe("nightly purge verdicts", () => {
  const closedAccount = { closedAt: new Date("2025-10-01T00:00:00Z"), purgeAt: PAST, identityPurgeAt: new Date("2030-10-01T00:00:00Z"), legalHold: [] };

  it("purges a closed account past purgeAt; nothing before, nothing without a closure", () => {
    expect(accountPurgeVerdict(closedAccount, "closed", NOW)).toEqual({ kind: "purge", keepIdentity: false, keepEmailBlock: false });
    expect(accountPurgeVerdict({ ...closedAccount, purgeAt: FUTURE }, "closed", NOW)).toEqual({ kind: "skip" });
    expect(accountPurgeVerdict({ ...closedAccount, closedAt: undefined }, "active", NOW)).toEqual({ kind: "skip" });
    expect(accountPurgeVerdict({ ...closedAccount, purgeAt: "2020-01-01" }, "closed", NOW)).toEqual({ kind: "skip" });
  });

  it("keeps an account under a legal hold", () => {
    expect(accountPurgeVerdict({ ...closedAccount, legalHold: ["authority:a1"] }, "closed", NOW)).toEqual({ kind: "held" });
  });

  it("keeps the civil identity, and a ban's e-mail block, until identityPurgeAt", () => {
    expect(accountPurgeVerdict({ ...closedAccount, legalName: "Salma Bennani" }, "closed", NOW)).toEqual({ kind: "purge", keepIdentity: true, keepEmailBlock: false });
    expect(accountPurgeVerdict(closedAccount, "banned", NOW)).toEqual({ kind: "purge", keepIdentity: true, keepEmailBlock: true });
    // Identity already due (a hold kept the account for years): nothing outlives the purge.
    expect(accountPurgeVerdict({ ...closedAccount, legalName: "Salma Bennani", identityPurgeAt: PAST }, "banned", NOW)).toEqual({ kind: "purge", keepIdentity: false, keepEmailBlock: false });
  });

  it("purges a kept identity past its purgeAt, unless held", () => {
    expect(identityPurgeable({ purgeAt: PAST, legalHold: [] }, NOW)).toBe(true);
    expect(identityPurgeable({ purgeAt: FUTURE, legalHold: [] }, NOW)).toBe(false);
    expect(identityPurgeable({ purgeAt: PAST, legalHold: ["authority:a1"] }, NOW)).toBe(false);
    expect(identityPurgeable({ legalHold: [] }, NOW)).toBe(false);
  });
});

describe("export budget", () => {
  it("stays near 2 000 Firestore reads per download", () => {
    expect(EXPORT_MAX_READS).toBeLessThanOrEqual(2000);
    expect(EXPORT_LIMITS.messages).toBeGreaterThanOrEqual(EXPORT_MESSAGES_PER_CONVERSATION);
  });

  it("shares the messages between conversations, newest conversations first", () => {
    expect(messageAllowances([3, 500, 10], 1000, 200)).toEqual([3, 200, 10]);
    expect(messageAllowances([150, 150, 150], 320, 200)).toEqual([150, 150, 20]);
    expect(messageAllowances([5, 5], 4, 200)).toEqual([4, 0]);
    expect(messageAllowances([])).toEqual([]);
  });
});
