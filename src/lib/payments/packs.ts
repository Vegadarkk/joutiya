import "server-only";
import { randomUUID } from "node:crypto";
import type { CreditPack } from "@/config/pricing";
import type { AuthContext } from "@/lib/auth/guards";
import { PACK_CONSENT_VERSION, type CheckoutPackInput, type CheckoutPackResponse, type PackOffer, type PacksResponse } from "@/lib/contracts/payments";
import { getBillingAccountTx, setBillingAccountTx } from "@/lib/db/repositories/billing";
import { getWallet } from "@/lib/db/repositories/wallets";
import type { BillingAccountDoc } from "@/lib/db/schemas";
import { getFlags, getPricing } from "@/lib/config/runtime";
import { serverEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { HttpError, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { memberBillingAccount, walletSummary } from "./options";

// Credit packs (phase 7 design §6): the packs page, then the checkout, which creates the billing
// account on first use (its RevenueCat app user id is a random UUID, never the uid), records the
// CGV consent and answers the Web Purchase Link of the pack. Payment happens on RevenueCat's page
// (Stripe as gateway); the webhook credits the wallet (src/lib/payments/revenuecat-events.ts).

export function packOffer(pack: CreditPack): PackOffer {
  return { id: pack.id, currency: pack.currency, priceMinor: pack.priceMinor, credits: pack.paid + pack.bonus, bonus: pack.bonus };
}

/** Web Purchase Link of `pack` for `rcAppUserId`: currency and package chosen, RevenueCat's own success step skipped. */
export function purchaseLink(base: string, rcAppUserId: string, pack: Pick<CreditPack, "currency" | "packageId">): string {
  const query = new URLSearchParams({ currency: pack.currency, package_id: pack.packageId, skip_purchase_success: "true" });
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(rcAppUserId)}?${query.toString()}`;
}

export async function packsView(auth: AuthContext, now = new Date()): Promise<PacksResponse> {
  const { accountId, kind } = memberBillingAccount(auth);
  const [flags, pricing, wallet] = await Promise.all([getFlags(), getPricing(), getWallet(accountId)]);
  return {
    salesOpen: flags.salesEnabled,
    available: Boolean(serverEnv().REVENUECAT_PURCHASE_LINK),
    account: kind,
    packs: pricing.packs.map(packOffer),
    wallet: walletSummary(wallet, now),
    consentVersion: PACK_CONSENT_VERSION,
  };
}

/** Opens the payment of a pack for the member's wallet (the shop's for its owner). */
export async function startPackCheckout(auth: AuthContext, input: CheckoutPackInput, now = new Date()): Promise<CheckoutPackResponse> {
  if (!(await getFlags()).salesEnabled) throw new HttpError(403, "sales_closed");
  const base = serverEnv().REVENUECAT_PURCHASE_LINK;
  if (!base) throw unavailable("REVENUECAT_PURCHASE_LINK is not set");
  const pack = (await getPricing()).packs.find((candidate) => candidate.id === input.packId);
  // A pack removed or repriced since the page loaded: the page reloads the grid.
  if (!pack || pack.priceMinor !== input.expectedPriceMinor) throw new HttpError(409, "price_changed");
  const { accountId, kind } = memberBillingAccount(auth);
  const { uid, claims } = auth.user;

  const account = await db().runTransaction(async (tx) => {
    const before = await getBillingAccountTx(tx, accountId);
    const next: BillingAccountDoc = {
      ...(before ?? { kind, ownerUid: uid, ...(kind === "shop" && claims.proId ? { proId: claims.proId } : {}), rcAppUserId: randomUUID(), createdAt: now }),
      lastCheckout: { packId: pack.id, consentVersion: PACK_CONSENT_VERSION, at: now },
      updatedAt: now,
    };
    setBillingAccountTx(tx, accountId, next);
    return next;
  });
  logger.info({ accountId, packId: pack.id }, "pack checkout opened");
  return { url: purchaseLink(base, account.rcAppUserId, pack) };
}
