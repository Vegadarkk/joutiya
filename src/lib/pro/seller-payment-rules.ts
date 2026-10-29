import type { ProPlan } from "@/config/pricing";
import { isAllowedPaymentHost, PAYMENT_LINK_DELAY_MS, paymentLinkHost, type SellerPaymentsConfig } from "@/config/seller-payments";
import { storefrontShown, type ProState } from "./lifecycle";
import type { ListingPaymentLink } from "@/lib/db/schemas";
import type { SellerPaymentDoc } from "./profile-schema";

// « Payer chez le vendeur » rules (design phase-7/boutique-temporaire.md §2). Pure: the save, the
// public button and the unit tests share them.

/** Shops that may take payments: those whose storefront is shown (verified, on the launch offer, a pass or a subscription, grace included). */
export function paymentEligible(lifecycle: string, plan: string): boolean {
  return storefrontShown(lifecycle as ProState, plan as ProPlan);
}

export interface EffectivePayment {
  /** The link the button opens now, or null. */
  url: string | null;
  host: string | null;
  /** A saved link not active yet: when it turns active (null while its host waits for review). */
  pending: { url: string; host: string; activeFrom: Date | null } | null;
}

/** The link in force at `now`: a pending one once 24 h old and its host allowed, else the previous one while its host stays allowed. */
export function effectivePayment(payment: Pick<SellerPaymentDoc, "url" | "pendingUrl" | "pendingFrom"> | undefined, config: SellerPaymentsConfig, now: Date): EffectivePayment {
  if (!payment) return { url: null, host: null, pending: null };
  const pendingHost = paymentLinkHost(payment.pendingUrl);
  if (payment.pendingUrl && pendingHost && payment.pendingFrom) {
    const allowed = isAllowedPaymentHost(pendingHost, config);
    const activeFrom = new Date(payment.pendingFrom.getTime() + PAYMENT_LINK_DELAY_MS);
    if (allowed && activeFrom.getTime() <= now.getTime()) return { url: payment.pendingUrl, host: pendingHost, pending: null };
    const current = activeLink(payment.url, config);
    return { ...current, pending: { url: payment.pendingUrl, host: pendingHost, activeFrom: allowed ? activeFrom : null } };
  }
  return { ...activeLink(payment.url, config), pending: null };
}

function activeLink(url: string | undefined, config: SellerPaymentsConfig): { url: string | null; host: string | null } {
  const host = paymentLinkHost(url);
  return url && host && isAllowedPaymentHost(host, config) ? { url, host } : { url: null, host: null };
}

/** The stored link with a matured pending one folded in (written at the next save). */
export function foldPending(payment: SellerPaymentDoc, config: SellerPaymentsConfig, now: Date): SellerPaymentDoc {
  if (!payment.pendingUrl) return payment;
  const effective = effectivePayment(payment, config, now);
  if (effective.pending) return payment;
  const { pendingUrl, pendingFrom: _from, pendingHost: _host, hostReview: _review, ...rest } = payment;
  return { ...rest, url: pendingUrl };
}

/**
 * A listing's own link as its owner sees it (catalogue §6): a pending link counts once 24 h old.
 * Its host was on the allowlist when saved; the click checks it again.
 */
export function ownerPaymentLink(link: Pick<ListingPaymentLink, "url" | "pendingUrl" | "pendingFrom"> | undefined, now: Date): { url: string | null; pending: { url: string; host: string; activeFrom: Date } | null } {
  if (!link) return { url: null, pending: null };
  const host = paymentLinkHost(link.pendingUrl);
  if (link.pendingUrl && host && link.pendingFrom) {
    const activeFrom = new Date(link.pendingFrom.getTime() + PAYMENT_LINK_DELAY_MS);
    if (activeFrom.getTime() <= now.getTime()) return { url: link.pendingUrl, pending: null };
    return { url: link.url ?? null, pending: { url: link.pendingUrl, host, activeFrom } };
  }
  return { url: link.url ?? null, pending: null };
}

/** Whether the shop shows « Payer chez le vendeur » or the cash-on-delivery badge at all. */
export function paymentShown(lifecycle: string, plan: string, payment: Pick<SellerPaymentDoc, "suspendedAt" | "info"> | undefined): boolean {
  return paymentEligible(lifecycle, plan) && payment !== undefined && !payment.suspendedAt && payment.info !== undefined;
}
