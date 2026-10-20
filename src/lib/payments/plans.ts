import "server-only";
import { randomUUID } from "node:crypto";
import { PAID_PLANS, type PricingConfig } from "@/config/pricing";
import type { Locale } from "@/config/site";
import type { AuthContext } from "@/lib/auth/guards";
import { PLAN_CONSENT_VERSION, type BillingRedirectResponse, type CheckoutPlanInput, type PlanOffer, type SubscriptionResponse } from "@/lib/contracts/payments";
import { getBillingAccount, getBillingAccountTx, getSubscription, setBillingAccountTx } from "@/lib/db/repositories/billing";
import { getProProfile, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import type { BillingAccountDoc } from "@/lib/db/schemas";
import { getFlags, getPricing } from "@/lib/config/runtime";
import { serverEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import type { ProLegal } from "@/lib/pro/kybc";
import { isStripeConfigured, stripeRequest } from "./stripe-api";

// Pro plans (phase 7 design §7): the plan page, the Stripe Checkout of a plan and the Customer
// Portal (plan switch, cancellation at period end, card, invoices). Owner of the shop only. The
// shop's billing account (`pro_{proId}`, the one its credit packs use) gets a Stripe Customer at
// its first checkout, with the shop's identifiers on its invoices (ICE, IF, RC). Checkout and
// subscription carry `app_user_id` (RevenueCat tracks the subscription) and `accountId`.

/** Lifecycle states of a verified, unsuspended shop (may subscribe). */
const SUBSCRIBABLE: ReadonlySet<string> = new Set(["verified", "active", "grace", "downgraded"]);

function shopOf(auth: AuthContext): { proId: string; accountId: string } {
  const { proId, proRole } = auth.user.claims;
  if (!proId) throw notFound();
  if (proRole !== "owner") throw new HttpError(403, "billing_owner_only");
  return { proId, accountId: `pro_${proId}` };
}

async function ownProfile(auth: AuthContext, proId: string): Promise<ProProfileRecord> {
  const profile = await getProProfile(proId);
  if (!profile || profile.ownerUid !== auth.user.uid) throw notFound();
  return profile;
}

function planOffers(pricing: PricingConfig): PlanOffer[] {
  return PAID_PLANS.map((id) => {
    const plan = pricing.plans[id];
    return {
      id,
      priceMinor: plan.priceMinor,
      credits: plan.credits,
      featured: plan.featured,
      activeListings: pricing.pro[id].activeListings,
      available: Boolean(plan.stripePrices.monthly && plan.stripePrices.yearly),
    };
  });
}

export async function subscriptionPage(auth: AuthContext): Promise<SubscriptionResponse> {
  const { proId, accountId } = shopOf(auth);
  const [flags, pricing, profile, subscription] = await Promise.all([getFlags(), getPricing(), ownProfile(auth, proId), getSubscription(accountId)]);
  return {
    salesOpen: flags.salesEnabled,
    available: isStripeConfigured(),
    lifecycle: profile.lifecycle,
    plan: profile.plan,
    planSource: profile.planSource,
    graceUntil: profile.graceUntil?.toISOString() ?? null,
    launchOfferEndsAt: pricing.launchOffer.active ? pricing.launchOffer.endsAt : null,
    subscription: subscription
      ? { plan: subscription.plan, interval: subscription.interval, status: subscription.status, periodEnd: subscription.periodEnd?.toISOString() ?? null, willRenew: subscription.willRenew }
      : null,
    plans: planOffers(pricing),
    consentVersion: PLAN_CONSENT_VERSION,
  };
}

/** The shop's identifiers printed on its invoices (Stripe allows 4 custom fields). */
export function invoiceFields(legal: ProLegal): { name: string; value: string }[] {
  const fields = [{ name: "ICE", value: legal.ice }];
  if (legal.form === "societe") fields.push({ name: "IF", value: legal.if }, { name: "RC", value: legal.rc });
  else if (legal.form === "auto_entrepreneur") fields.push({ name: "N° auto-entrepreneur", value: legal.aeNumber });
  else {
    if (legal.rc) fields.push({ name: "RC", value: legal.rc });
    if (legal.tp) fields.push({ name: "Taxe professionnelle", value: legal.tp });
  }
  return fields.slice(0, 4);
}

function pageUrl(locale: Locale, query = ""): string {
  return `${serverEnv().SITE_URL.replace(/\/+$/, "")}/${locale}/pro/abonnement${query}`;
}

/** Creates the shop's Stripe Customer once, or brings its name and identifiers up to date. */
async function stripeCustomer(account: BillingAccountDoc & { id: string }, profile: ProProfileRecord, email: string | undefined): Promise<string> {
  const params = {
    name: profile.name,
    ...(email ? { email } : {}),
    preferred_locales: ["fr"],
    metadata: { accountId: account.id, app_user_id: account.rcAppUserId },
    invoice_settings: { custom_fields: invoiceFields(profile.legal) },
  };
  if (account.stripeCustomerId) {
    await stripeRequest("POST", `/v1/customers/${encodeURIComponent(account.stripeCustomerId)}`, params);
    return account.stripeCustomerId;
  }
  const created = await stripeRequest<{ id: string }>("POST", "/v1/customers", params, { idempotencyKey: `customer_${account.id}` });
  if (!/^cus_[A-Za-z0-9]{1,100}$/.test(created.id)) throw new HttpError(502, "unavailable", "Stripe answered an unexpected customer id");
  await db().runTransaction(async (tx) => {
    const current = await getBillingAccountTx(tx, account.id);
    if (current && !current.stripeCustomerId) setBillingAccountTx(tx, account.id, { ...current, stripeCustomerId: created.id, updatedAt: new Date() });
  });
  return created.id;
}

/** Opens the Stripe Checkout of a plan for the owner's shop. */
export async function startPlanCheckout(auth: AuthContext, input: CheckoutPlanInput, locale: Locale, now = new Date()): Promise<BillingRedirectResponse> {
  const [flags, pricing] = await Promise.all([getFlags(), getPricing()]);
  if (!flags.salesEnabled) throw new HttpError(403, "sales_closed");
  if (!isStripeConfigured()) throw unavailable("STRIPE_SECRET_KEY is not set");
  const price = pricing.plans[input.plan].stripePrices[input.interval];
  if (!price) throw unavailable(`no Stripe price for ${input.plan} ${input.interval}`);
  const { proId, accountId } = shopOf(auth);
  const profile = await ownProfile(auth, proId);
  if (!SUBSCRIBABLE.has(profile.lifecycle)) throw new HttpError(409, "pro_not_verified");
  const current = await getSubscription(accountId);
  // A plan that still runs is changed or resumed in the portal, never paid twice.
  if (current && current.status !== "expired") throw new HttpError(409, "already_subscribed");

  const account = await db().runTransaction(async (tx) => {
    const before = await getBillingAccountTx(tx, accountId);
    const next: BillingAccountDoc = {
      ...(before ?? { kind: "shop" as const, ownerUid: auth.user.uid, proId, rcAppUserId: randomUUID(), createdAt: now }),
      lastPlanCheckout: { plan: input.plan, interval: input.interval, consentVersion: PLAN_CONSENT_VERSION, at: now },
      updatedAt: now,
    };
    setBillingAccountTx(tx, accountId, next);
    return { ...next, id: accountId };
  });
  const customer = await stripeCustomer(account, profile, auth.user.email);
  const metadata = { accountId, app_user_id: account.rcAppUserId };
  const session = await stripeRequest<{ url?: string | null }>(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer,
      client_reference_id: accountId,
      // Stripe has no Arabic: French for every shop (said on the plan page).
      locale: "fr",
      line_items: [{ price, quantity: 1, ...(pricing.plans.stripeTaxRate ? { tax_rates: [pricing.plans.stripeTaxRate] } : {}) }],
      billing_address_collection: "required",
      customer_update: { address: "auto" },
      success_url: pageUrl(locale, "?abonnement=ok"),
      cancel_url: pageUrl(locale),
      metadata,
      subscription_data: { metadata },
    },
    // The same plan asked again the same day reopens the same session (valid 24 hours).
    { idempotencyKey: `checkout_${accountId}_${input.plan}_${input.interval}_${now.toISOString().slice(0, 10)}` },
  );
  if (!session.url?.startsWith("https://checkout.stripe.com/")) throw new HttpError(502, "unavailable", "Stripe answered an unexpected checkout URL");
  logger.info({ accountId, plan: input.plan, interval: input.interval }, "plan checkout opened");
  return { url: session.url };
}

/** Opens the Stripe Customer Portal of the owner's shop. */
export async function openBillingPortal(auth: AuthContext, locale: Locale): Promise<BillingRedirectResponse> {
  if (!isStripeConfigured()) throw unavailable("STRIPE_SECRET_KEY is not set");
  const { proId, accountId } = shopOf(auth);
  await ownProfile(auth, proId);
  const account = await getBillingAccount(accountId);
  if (!account?.stripeCustomerId) throw new HttpError(409, "no_billing_customer");
  const session = await stripeRequest<{ url?: string | null }>("POST", "/v1/billing_portal/sessions", { customer: account.stripeCustomerId, return_url: pageUrl(locale), locale: "fr" });
  if (!session.url?.startsWith("https://billing.stripe.com/")) throw new HttpError(502, "unavailable", "Stripe answered an unexpected portal URL");
  return { url: session.url };
}
