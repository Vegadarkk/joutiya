import { describe, expect, it } from "vitest";
import { EMPTY_WALLET, WalletError, creditPurchase, grantPlanPeriod, refundPurchase, reverseRefund, spendOption, type WalletState } from "@/lib/payments/wallet";

// Credits wallet arithmetic (architecture §5, §8): plan credits first, À la Une allowance, refunds
// of spent packs to a negative frozen balance, monthly grant reset.

function wallet(extra: Partial<WalletState> = {}): WalletState {
  return { ...EMPTY_WALLET, ...extra };
}

describe("purchase", () => {
  it("adds paid and bonus credits and records both parts", () => {
    const { wallet: w, ledger } = creditPurchase(wallet({ balance: 5 }), { paid: 100, bonus: 10 });
    expect(w.balance).toBe(115);
    expect(ledger).toMatchObject({ reason: "purchase", delta: 110, paidPart: 100, bonusPart: 10, balanceAfter: 115 });
  });

  it("unfreezes only once a negative balance is covered", () => {
    expect(creditPurchase(wallet({ balance: -80, frozen: true }), { paid: 50, bonus: 0 }).wallet).toMatchObject({ balance: -30, frozen: true });
    expect(creditPurchase(wallet({ balance: -30, frozen: true }), { paid: 50, bonus: 0 }).wallet).toMatchObject({ balance: 20, frozen: false });
  });

  it("refuses non-integer or negative amounts", () => {
    expect(() => creditPurchase(wallet(), { paid: 10.5, bonus: 0 })).toThrow(WalletError);
    expect(() => creditPurchase(wallet(), { paid: -1, bonus: 0 })).toThrow(WalletError);
  });
});

describe("spending on options", () => {
  it("uses plan credits before the purchased balance", () => {
    const { wallet: w, ledger } = spendOption(wallet({ balance: 50, planCredits: 20 }), 29);
    expect(w).toMatchObject({ planCredits: 0, balance: 41 });
    expect(ledger).toMatchObject({ reason: "option", delta: -9, planCreditsDelta: -20, balanceAfter: 41 });
  });

  it("uses the À la Une allowance when asked and available", () => {
    const { wallet: w, ledger } = spendOption(wallet({ balance: 0, featuredAllowance: 4 }), 59, { useAllowance: true });
    expect(w).toMatchObject({ featuredAllowance: 3, balance: 0 });
    expect(ledger).toMatchObject({ delta: 0, featuredAllowanceDelta: -1 });
    expect(spendOption(wallet({ balance: 59 }), 59, { useAllowance: true }).wallet.balance).toBe(0);
  });

  it("refuses an insufficient or frozen wallet", () => {
    expect(() => spendOption(wallet({ balance: 9, planCredits: 0 }), 10)).toThrow(new WalletError("insufficient"));
    expect(() => spendOption(wallet({ balance: 500, frozen: true }), 10)).toThrow(new WalletError("frozen"));
    expect(() => spendOption(wallet({ balance: -1, planCredits: 100 }), 10)).toThrow(new WalletError("frozen"));
  });
});

describe("refunds and chargebacks", () => {
  it("debits a spent pack to a negative frozen balance", () => {
    const { wallet: w, ledger } = refundPurchase(wallet({ balance: 30 }), { paid: 100, bonus: 10 });
    expect(w).toMatchObject({ balance: -80, frozen: true });
    expect(ledger).toMatchObject({ reason: "refund", delta: -110, paidPart: -100, bonusPart: -10, balanceAfter: -80 });
  });

  it("keeps the wallet usable when the balance covers the refund", () => {
    expect(refundPurchase(wallet({ balance: 200 }), { paid: 50, bonus: 0 }).wallet).toMatchObject({ balance: 150, frozen: false });
  });

  it("gives the pack back on a reversed refund and unfreezes", () => {
    const { wallet: w, ledger } = reverseRefund(wallet({ balance: -80, frozen: true }), { paid: 100, bonus: 10 });
    expect(w).toMatchObject({ balance: 30, frozen: false });
    expect(ledger.reason).toBe("refund_reversed");
  });
});

describe("plan period grant", () => {
  it("resets, not adds, the monthly credits and allowance", () => {
    const { wallet: w, ledger } = grantPlanPeriod(wallet({ balance: 12, planCredits: 7, featuredAllowance: 1 }), { credits: 100, featured: 4 });
    expect(w).toEqual({ balance: 12, frozen: false, planCredits: 100, featuredAllowance: 4 });
    expect(ledger).toMatchObject({ reason: "plan_grant", delta: 0, planCreditsDelta: 93, featuredAllowanceDelta: 3, balanceAfter: 12 });
  });
});
