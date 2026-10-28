import "server-only";
import { randomUUID } from "node:crypto";
import { launchOfferOpen, passById, type PassConfig, type PricingConfig } from "@/config/pricing";
import type { Locale } from "@/config/site";
import { alert } from "@/lib/alert";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guards";
import { PASS_CONSENT_VERSION, type BillingRedirectResponse, type CheckoutPassInput } from "@/lib/contracts/payments";
import { getBillingAccount, getBillingAccountTx, getSubscription, setBillingAccountTx, type BillingAccountRecord } from "@/lib/db/repositories/billing";
import { getProProfile, listPassProfiles, markPassNotice, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { getLedgerEntryTx, getWalletTx, recordWalletOperationTx, walletStateAt } from "@/lib/db/repositories/wallets";
import type { BillingAccountDoc } from "@/lib/db/schemas";
import { getFlags, getPricing } from "@/lib/config/runtime";
import { serverEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient } from "@/lib/mail/recipients";
import { transition, type ProEvent } from "@/lib/pro/lifecycle";
import { pauseListingsOverQuota } from "@/lib/pro/quota";
import { mailBudget } from "./launch-offer";
import { passEndAfter, passNoticeDue, runningPassEnd } from "./pass-rules";
import { ownShop, pageUrl, SESSION_LIFETIME_MS, stripeCustomer } from "./plans";
import { isStripeConfigured, stripeRequest } from "./stripe-api";
import { profileAfter } from "./subscriptions";
import { grantPlanPeriod } from "./wallet";

// Pass Boutique (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §1): a plan's
// quotas and storefront for `days`, one payment, no subscription.
// - Checkout: Stripe Checkout in `payment` mode for the shop's owner, with an invoice (the sales
//   exports read Stripe's paid invoices), sales open only, never over a running subscription or the
//   free launch offer, and never more than `maxAheadDays` ahead.
// - Webhook: `checkout.session.completed` of a pass (metadata kind "pass") re-reads the session
//   from Stripe, then in one transaction extends `passEndsAt` (from the running pass's end, or now),
//   moves the shop to `active` with `planSource: "pass"` and grants the pass's plan credits until
//   that end. The ledger entry `pass_{session}` makes a replay a no-op. RevenueCat is not involved.
// - Nightly (pro-plans job): notices at J-7 and J-1, then `pass_ended` (downgraded, no grace), its
//   listings over the free quota paused and a last mail.

/** Lifecycle states that may buy a pass (an active shop only when it runs on a pass). */
const PASS_BUYERS: ReadonlySet<string> = new Set(["verified", "active", "downgraded"]);

/** Opens the Stripe Checkout of a Pass Boutique for the owner's shop. */
export async function startPassCheckout(auth: AuthContext, input: CheckoutPassInput, locale: Locale, now = new Date()): Promise<BillingRedirectResponse> {
  const [flags, pricing] = await Promise.all([getFlags(), getPricing()]);
  if (!flags.salesEnabled) throw new HttpError(403, "sales_closed");
  if (!isStripeConfigured()) throw unavailable("STRIPE_SECRET_KEY is not set");
  const pass = passById(input.pass, pricing);
  if (!pass) throw notFound();
  if (!pass.stripePrice) throw unavailable(`no Stripe price for pass ${pass.id}`);
  const { proId, accountId, profile } = await ownShop(auth);
  if (!PASS_BUYERS.has(profile.lifecycle)) throw new HttpError(409, "pro_not_verified");
  if (profile.planSource === "launch_offer" && launchOfferOpen(pricing.launchOffer, now)) throw new HttpError(409, "launch_offer_running");
  const [current, existing] = await Promise.all([getSubscription(accountId), getBillingAccount(accountId)]);
  if ((current && current.status !== "expired") || (profile.lifecycle === "active" && profile.planSource !== "pass")) throw new HttpError(409, "already_subscribed");
  if (!passEndAfter(runningPassEnd(profile, now), pass, now)) throw new HttpError(409, "pass_max_ahead");

  const idempotencyKey = `pass_${accountId}_${pass.id}_${locale}_${pass.stripePrice}_${now.toISOString().slice(0, 10)}`;
  const previous = existing?.lastPassCheckout;
  // Another pass page still payable is closed first, so that one click pays one pass.
  if (previous?.sessionId && previous.idempotencyKey !== idempotencyKey && now.getTime() - previous.at.getTime() < SESSION_LIFETIME_MS) await expireIfOpen(previous.sessionId);

  const account = await db().runTransaction(async (tx) => {
    const before = await getBillingAccountTx(tx, accountId);
    const next: BillingAccountDoc = {
      ...(before ?? { kind: "shop" as const, ownerUid: auth.user.uid, proId, rcAppUserId: randomUUID(), createdAt: now }),
      lastPassCheckout: { passId: pass.id, consentVersion: PASS_CONSENT_VERSION, at: now, idempotencyKey },
      updatedAt: now,
    };
    setBillingAccountTx(tx, accountId, next);
    return { ...next, id: accountId };
  });
  const customer = await stripeCustomer(account, profile, auth.user.email);
  const metadata = { accountId, app_user_id: account.rcAppUserId, env: serverEnv().APP_ENV, kind: "pass", passId: pass.id };
  const session = await stripeRequest<{ id?: string; url?: string | null }>(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "payment",
      customer,
      client_reference_id: accountId,
      locale: "fr",
      // Cards only: the payment is settled when the session completes (no delayed method).
      payment_method_types: ["card"],
      line_items: [{ price: pass.stripePrice, quantity: 1, ...(pricing.plans.stripeTaxRate ? { tax_rates: [pricing.plans.stripeTaxRate] } : {}) }],
      billing_address_collection: "required",
      customer_update: { address: "auto" },
      invoice_creation: { enabled: true, invoice_data: { metadata } },
      payment_intent_data: { metadata },
      success_url: pageUrl(locale, "?pass=ok"),
      cancel_url: pageUrl(locale),
      metadata,
    },
    { idempotencyKey },
  );
  if (!session.url?.startsWith("https://checkout.stripe.com/")) throw new HttpError(502, "unavailable", "Stripe answered an unexpected checkout URL");
  const sessionId = session.id;
  if (sessionId && /^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) {
    await db().runTransaction(async (tx) => {
      const latest = await getBillingAccountTx(tx, accountId);
      if (latest?.lastPassCheckout?.idempotencyKey === idempotencyKey) setBillingAccountTx(tx, accountId, { ...latest, lastPassCheckout: { ...latest.lastPassCheckout, sessionId } });
    });
  }
  logger.info({ accountId, pass: pass.id }, "pass checkout opened");
  return { url: session.url };
}

async function expireIfOpen(sessionId: string): Promise<void> {
  const path = `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  const session = await stripeRequest<{ status?: unknown }>("GET", path);
  if (session.status === "open") await stripeRequest("POST", `${path}/expire`);
}

/** What a paid pass session does to the shop (pure: the webhook's transaction applies it). */
export function passPurchaseEffect(profile: Pick<ProProfileRecord, "lifecycle" | "planSource" | "passEndsAt">, pass: Pick<PassConfig, "plan" | "days" | "maxAheadDays">, now: Date): { endsAt: Date; event: ProEvent | null } | null {
  const applies = profile.lifecycle === "verified" || profile.lifecycle === "downgraded" || (profile.lifecycle === "active" && profile.planSource === "pass");
  if (!applies) return null;
  // Paid: the days are given even past `maxAheadDays` (two pages paid at once), the limit is the checkout's.
  const endsAt = passEndAfter(runningPassEnd(profile, now), { days: pass.days, maxAheadDays: Number.MAX_SAFE_INTEGER }, now)!;
  const event: ProEvent | null = profile.lifecycle === "active" ? null : { type: "pass_purchased", plan: pass.plan };
  return { endsAt, event };
}

interface StripeSession {
  id?: string;
  status?: unknown;
  payment_status?: unknown;
  mode?: unknown;
  metadata?: Record<string, string> | null;
}

export type PassOutcome = "updated" | "unchanged" | "no_shop" | "unknown_pass" | "not_applied";

/** Ledger ids keep to the characters the wallet page's cursor accepts. */
const ledgerKey = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

/** Applies a completed pass Checkout Session (re-read from Stripe) to the shop of `account`. */
export async function applyPassSession(account: BillingAccountRecord, sessionId: string, deps: { stripe?: typeof stripeRequest; now?: () => Date } = {}): Promise<PassOutcome> {
  const session = await (deps.stripe ?? stripeRequest)<StripeSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.mode !== "payment" || session.metadata?.kind !== "pass" || session.status !== "complete" || session.payment_status !== "paid") return "unchanged";
  if (!account.proId || session.metadata.accountId !== account.id) return "no_shop";
  const proId = account.proId;
  const pricing = await getPricing();
  const pass = passById(session.metadata.passId ?? "", pricing);
  const now = deps.now?.() ?? new Date();
  if (!pass) {
    await alert({
      severity: "P1",
      title: `Pass Boutique payé mais inconnu (${proId})`,
      body: `La session Stripe ${sessionId} a payé le pass « ${session.metadata.passId ?? "?"} », absent de config/pricing.passes. Remettre le pass dans la configuration puis rejouer l'événement, ou rembourser dans Stripe.`,
    });
    return "unknown_pass";
  }
  const entryId = `pass_${ledgerKey(sessionId)}`;
  const result = await db().runTransaction(async (tx) => {
    if (await getLedgerEntryTx(tx, account.id, entryId)) return { outcome: "unchanged" as const };
    const profile = await getProProfile(proId, tx);
    if (!profile) return { outcome: "no_shop" as const };
    const wallet = await getWalletTx(tx, account.id);
    const state = walletStateAt(wallet, now);
    const effect = passPurchaseEffect(profile, pass, now);
    // Not applicable (suspended, under a subscription, not verified): recorded once, left to an admin.
    const grant = effect ? { credits: pass.credits, featured: pricing.plans[pass.plan].featured } : { credits: state.planCredits, featured: state.featuredAllowance };
    const { wallet: nextState, ledger } = grantPlanPeriod(state, grant);
    recordWalletOperationTx(tx, account.id, entryId, { before: wallet, state: nextState, ledger, entry: { refs: { orderId: sessionId }, actorUid: "system", at: now }, now, ...(effect ? { resetsAt: effect.endsAt } : {}) });
    if (!effect) return { outcome: "not_applied" as const, lifecycle: profile.lifecycle };
    const { proId: _proId, ...doc } = profile;
    const base = effect.event ? profileAfter(profile, transition(profile, effect.event, { now, graceDays: pricing.graceDays }).patch, pricing, now) : { ...doc, updatedAt: now };
    // A new end: the notices start over.
    const { passNoticeSentAt: _sent, ...next } = { ...base, passEndsAt: effect.endsAt };
    tx.set(proProfileRef(proId), proProfileToFirestore(next));
    return { outcome: "updated" as const, endsAt: effect.endsAt, event: effect.event };
  });

  if (result.outcome === "not_applied") {
    await alert({
      severity: "P1",
      title: `Pass Boutique payé par une boutique ${result.lifecycle} (${proId})`,
      body: `La session Stripe ${sessionId} a payé un pass, mais la boutique ${proId} est « ${result.lifecycle} » : le pass n'est pas appliqué. Vérifier la boutique, puis rembourser dans Stripe ou prolonger à la main.`,
    });
  }
  if (result.outcome === "updated") {
    logger.info({ proId, pass: pass.id, endsAt: result.endsAt.toISOString() }, "pass applied");
    await audit({ actorUid: "system", actorRole: "system", action: result.event ? "pro.pass.purchased" : "pro.pass.extended", target: { type: "pro", id: proId }, automated: true, at: now }).catch((error: unknown) =>
      logger.error({ proId, err: (error as Error).message }, "pass audit failed"),
    );
  }
  return result.outcome;
}

export interface PassExpiryRun {
  noticed: number;
  ended: number;
  failed: number;
  deferred?: true;
}

const PAGE = 100;
const MAX_PAGES = 50;

/** Nightly: notices before the end of each running pass, then the downgrade of the ended ones. */
export async function runPassExpiry(now = new Date()): Promise<PassExpiryRun> {
  const run: PassExpiryRun = { noticed: 0, ended: 0, failed: 0 };
  const pricing = await getPricing();
  let budget = await mailBudget();
  let after: string | null = null;
  pages: for (let page = 0; page < MAX_PAGES; page += 1) {
    const { profiles, next } = await listPassProfiles(after, PAGE);
    for (const profile of profiles) {
      // A suspended shop waits for its reinstatement (back to active, its pass ends then).
      if (profile.lifecycle !== "active" || !profile.passEndsAt) continue;
      const ended = now.getTime() >= profile.passEndsAt.getTime();
      const due = ended ? null : passNoticeDue(profile.passEndsAt, profile.passNoticeSentAt, now);
      if (!ended && due === null) continue;
      if (budget <= 0) {
        run.deferred = true;
        break pages;
      }
      budget -= 1;
      try {
        if (ended) {
          if (await endPass(profile.proId, pricing, now)) run.ended += 1;
        } else {
          await notify(profile, { kind: "ending", endsAt: profile.passEndsAt.toISOString(), freeListings: pricing.pro.none.activeListings, paused: 0 }, `ending-${due}-${profile.passEndsAt.getTime()}`);
          await markPassNotice(profile.proId, now);
          run.noticed += 1;
        }
      } catch (error) {
        run.failed += 1;
        logger.error({ proId: profile.proId, err: (error as Error).message }, "pass expiry: one shop not handled");
      }
    }
    if (!next) break;
    after = next;
  }
  if (run.deferred) logger.warn({ ...run }, "pass expiry: mail budget used up, the other shops wait for the next night");
  else if (run.noticed + run.ended + run.failed > 0) logger.info({ ...run }, "pass expiry done");
  return run;
}

/** Downgrades one shop whose pass ended (re-read in the transaction); false when it moved meanwhile. */
async function endPass(proId: string, pricing: PricingConfig, now: Date): Promise<boolean> {
  const ended = await db().runTransaction(async (tx) => {
    const profile = await getProProfile(proId, tx);
    if (!profile || profile.lifecycle !== "active" || profile.planSource !== "pass" || !profile.passEndsAt || profile.passEndsAt.getTime() > now.getTime()) return null;
    const { patch } = transition(profile, { type: "pass_ended" }, { now, graceDays: pricing.graceDays });
    tx.set(proProfileRef(proId), proProfileToFirestore(profileAfter(profile, patch, pricing, now)));
    return profile;
  });
  if (!ended) return false;
  await audit({ actorUid: "system", actorRole: "system", action: "pro.pass.ended", target: { type: "pro", id: proId }, automated: true, at: now }).catch((error: unknown) =>
    logger.error({ proId, err: (error as Error).message }, "pass audit failed"),
  );
  let paused: string[] = [];
  try {
    paused = await pauseListingsOverQuota(ended.ownerUid, pricing.pro.none.activeListings, now);
  } catch (error) {
    logger.error({ proId, err: (error as Error).message }, "quota pause failed");
  }
  try {
    await notify(ended, { kind: "ended", endsAt: ended.passEndsAt!.toISOString(), freeListings: pricing.pro.none.activeListings, paused: paused.length }, `ended-${ended.passEndsAt!.getTime()}`);
  } catch (error) {
    logger.warn({ proId, err: (error as Error).message }, "pass end mail not sent");
  }
  return true;
}

async function notify(profile: ProProfileRecord, data: { kind: "ending" | "ended"; endsAt: string; freeListings: number | null; paused: number }, key: string): Promise<void> {
  const to = await listingRecipient(profile.ownerUid);
  if (!to) return;
  await sendMail({
    template: "passNotice",
    locale: to.locale,
    to: to.email,
    priority: "transactional",
    idempotencyKey: `pass-${profile.proId}-${key}`,
    data: { displayName: to.displayName, shopName: profile.name, ...data },
  });
}
