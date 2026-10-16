// Credits wallet arithmetic (architecture §5 "Facturation et porte-monnaie", §8; phase 7 design §3,
// §5). Pure: each operation returns the wallet patch and the ledger entry; the billing service
// writes both in one Firestore transaction with the order or the listing boost. 1 credit = 1 MAD
// TTC; amounts are integers.
//
// Spending order: the plan's monthly credits first (not cumulative, reset each period), then the
// purchased balance. À la Une can use the plan's monthly allowance instead of credits (Business).
// A refund or a chargeback debits the whole pack even if already spent: the balance may go
// negative, the wallet is then frozen (no option purchase) and the account flagged.

export interface WalletState {
  balance: number;
  frozen: boolean;
  planCredits: number;
  featuredAllowance: number;
}

export type LedgerReason = "purchase" | "option" | "plan_grant" | "refund" | "refund_reversed" | "admin_adjust";

export interface LedgerDraft {
  reason: LedgerReason;
  /** Change of the purchased balance (negative for a debit). */
  delta: number;
  /** Paid and bonus parts of a purchase or refund (bonus = discount, out of the taxable base). */
  paidPart: number;
  bonusPart: number;
  /** Monthly plan credits used or granted, kept apart from the balance. */
  planCreditsDelta: number;
  featuredAllowanceDelta: number;
  balanceAfter: number;
}

export interface WalletResult {
  wallet: WalletState;
  ledger: LedgerDraft;
}

export class WalletError extends Error {
  constructor(readonly code: "frozen" | "insufficient" | "invalid_amount") {
    super(code);
    this.name = "WalletError";
  }
}

function assertCredits(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new WalletError("invalid_amount");
}

export const EMPTY_WALLET: WalletState = { balance: 0, frozen: false, planCredits: 0, featuredAllowance: 0 };

/** Credits of a paid pack (paid part + bonus) land on the balance; a negative balance stays frozen until covered. */
export function creditPurchase(wallet: WalletState, pack: { paid: number; bonus: number }): WalletResult {
  assertCredits(pack.paid);
  assertCredits(pack.bonus);
  const balance = wallet.balance + pack.paid + pack.bonus;
  return {
    wallet: { ...wallet, balance, frozen: wallet.frozen && balance < 0 },
    ledger: { reason: "purchase", delta: pack.paid + pack.bonus, paidPart: pack.paid, bonusPart: pack.bonus, planCreditsDelta: 0, featuredAllowanceDelta: 0, balanceAfter: balance },
  };
}

/**
 * Pays an option of `price` credits. `featured` options use one monthly allowance unit first
 * when the plan has some (`useAllowance`), at no credit cost.
 */
export function spendOption(wallet: WalletState, price: number, opts: { useAllowance?: boolean } = {}): WalletResult {
  assertCredits(price);
  if (wallet.frozen || wallet.balance < 0) throw new WalletError("frozen");
  if (opts.useAllowance && wallet.featuredAllowance > 0) {
    return {
      wallet: { ...wallet, featuredAllowance: wallet.featuredAllowance - 1 },
      ledger: { reason: "option", delta: 0, paidPart: 0, bonusPart: 0, planCreditsDelta: 0, featuredAllowanceDelta: -1, balanceAfter: wallet.balance },
    };
  }
  if (wallet.planCredits + wallet.balance < price) throw new WalletError("insufficient");
  const fromPlan = Math.min(wallet.planCredits, price);
  const fromBalance = price - fromPlan;
  const balance = wallet.balance - fromBalance;
  return {
    wallet: { ...wallet, planCredits: wallet.planCredits - fromPlan, balance },
    ledger: { reason: "option", delta: -fromBalance, paidPart: 0, bonusPart: 0, planCreditsDelta: -fromPlan, featuredAllowanceDelta: 0, balanceAfter: balance },
  };
}

/** Refund or chargeback of a pack: the whole pack is debited even if spent; negative => frozen. */
export function refundPurchase(wallet: WalletState, pack: { paid: number; bonus: number }): WalletResult {
  assertCredits(pack.paid);
  assertCredits(pack.bonus);
  const balance = wallet.balance - pack.paid - pack.bonus;
  return {
    wallet: { ...wallet, balance, frozen: wallet.frozen || balance < 0 },
    ledger: { reason: "refund", delta: -(pack.paid + pack.bonus), paidPart: -pack.paid, bonusPart: -pack.bonus, planCreditsDelta: 0, featuredAllowanceDelta: 0, balanceAfter: balance },
  };
}

/** A reversed refund or a won dispute gives the pack back; the wallet unfreezes once the balance is >= 0. */
export function reverseRefund(wallet: WalletState, pack: { paid: number; bonus: number }): WalletResult {
  const result = creditPurchase(wallet, pack);
  return { wallet: result.wallet, ledger: { ...result.ledger, reason: "refund_reversed" } };
}

/** New plan period: monthly credits and À la Une allowance are reset (not added) to the plan's grant. */
export function grantPlanPeriod(wallet: WalletState, grant: { credits: number; featured: number }): WalletResult {
  assertCredits(grant.credits);
  assertCredits(grant.featured);
  return {
    wallet: { ...wallet, planCredits: grant.credits, featuredAllowance: grant.featured },
    ledger: {
      reason: "plan_grant",
      delta: 0,
      paidPart: 0,
      bonusPart: 0,
      planCreditsDelta: grant.credits - wallet.planCredits,
      featuredAllowanceDelta: grant.featured - wallet.featuredAllowance,
      balanceAfter: wallet.balance,
    },
  };
}
