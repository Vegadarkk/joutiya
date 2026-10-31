import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "@/lib/config/runtime";
import type * as RevenueCatApiModule from "@/lib/payments/revenuecat-api";
import type { RevenueCatPurchase } from "@/lib/payments/revenuecat-api";

// Credit packs (phase 7 design §6, §10): the checkout (sales gate, price binding, consent, the
// billing account and its RevenueCat id), the webhook (Authorization + HMAC, environment filter,
// a duplicate delivery), the credit re-checked against RevenueCat's API (a purchase not visible
// yet retries), a pack for an unknown customer, and a refund after spending that leaves the
// wallet negative and frozen.

const flags = vi.hoisted(() => ({ salesEnabled: true, proSignupEnabled: true, paymentInstallmentsEnabled: false }));
const store = vi.hoisted(() => ({ purchases: [] as RevenueCatPurchase[] }));
vi.mock("@/lib/config/runtime", async (importOriginal) => ({ ...(await importOriginal<typeof RuntimeModule>()), getFlags: vi.fn(async () => ({ ...flags })) }));
vi.mock("@/lib/payments/revenuecat-api", async (importOriginal) => ({ ...(await importOriginal<typeof RevenueCatApiModule>()), listCustomerPurchases: vi.fn(async () => store.purchases) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async (token: string) => ({ ok: token !== "refused", codes: [] })) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as webhook } from "@/app/api/webhooks/revenuecat/route";
import { GET as packs, POST as checkout } from "@/app/api/wallet/packs/route";
import type { CheckoutPackResponse, PacksResponse } from "@/lib/contracts/payments";
import { alert } from "@/lib/alert";
import { billingAccountRef, billingEventRef, createBillingEvent, getOrder } from "@/lib/db/repositories/billing";
import { getWallet, ledgerRef, setWallet } from "@/lib/db/repositories/wallets";
import { resetServerEnv } from "@/lib/env";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { reconcileBilling } from "@/lib/payments/reconcile";
import { expectedSignature } from "@/lib/payments/revenuecat-webhook";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, type ErrorBody, type Member } from "../listings/helpers";

const AUTH = "Bearer rc-test-authorization";
const SECRET = "rc-test-signing-secret";
const LINK = "https://pay.rev.cat/sandbox-token";
const VARS = { REVENUECAT_PURCHASE_LINK: LINK, REVENUECAT_WEBHOOK_AUTH: AUTH, REVENUECAT_WEBHOOK_HMAC_SECRET: SECRET, REVENUECAT_PROJECT_ID: "proj-test", REVENUECAT_SECRET_API_KEY: "sk-test" };

beforeAll(() => {
  Object.assign(process.env, VARS);
  resetServerEnv();
});
afterAll(() => {
  for (const name of Object.keys(VARS)) delete process.env[name];
  resetServerEnv();
});
beforeEach(() => {
  resetRateLimiters();
  flags.salesEnabled = true;
  store.purchases = [];
  vi.mocked(alert).mockClear();
});

const code = (body: unknown) => (body as ErrorBody).error.code;
const pay = (buyer: Member, body: unknown) => api<CheckoutPackResponse & ErrorBody>(checkout, "POST", "/api/wallet/packs", { member: buyer, body });
const order = (packId = "mad_100", expectedPriceMinor = 10_000) => ({ packId, expectedPriceMinor, acceptTerms: true, turnstileToken: "dev" });

/** Opens a checkout and answers the buyer's RevenueCat app user id (read back from the link). */
async function checkoutOf(buyer: Member, packId = "mad_100", price = 10_000): Promise<string> {
  const result = await pay(buyer, order(packId, price));
  expect(result.status).toBe(200);
  const url = new URL(result.body.url);
  return decodeURIComponent(url.pathname.split("/").pop()!);
}

function rcEvent(type: string, appUserId: string, transactionId: string, extra: Record<string, unknown> = {}) {
  return {
    api_version: "1.0",
    event: {
      id: randomUUID(),
      type,
      environment: "SANDBOX",
      app_user_id: appUserId,
      original_app_user_id: appUserId,
      product_id: "joutiya_credits_100_mad",
      transaction_id: transactionId,
      store: "RC_BILLING",
      currency: "MAD",
      price_in_purchased_currency: 100,
      country_code: "MA",
      event_timestamp_ms: Date.now(),
      ...extra,
    },
  };
}

/** A delivery as RevenueCat sends it: the static Authorization value and the HMAC of the raw body. */
async function deliver(envelope: unknown, options: { authorization?: string; secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(envelope);
  const t = Math.floor((options.at ?? Date.now()) / 1000);
  const signature = expectedSignature(options.secret ?? SECRET, t, raw);
  return api<ErrorBody>(webhook, "POST", "/api/webhooks/revenuecat", { body: envelope, origin: null, headers: { authorization: options.authorization ?? AUTH, "x-revenuecat-webhook-signature": `t=${t},v1=${signature}` } });
}

const owned = (transactionId: string, status = "owned"): RevenueCatPurchase => ({ id: `rcp_${transactionId}`, storePurchaseIdentifier: transactionId, status, environment: "sandbox", quantity: 1 });

describe("pack checkout", () => {
  it("lists the packs and opens the payment link of the chosen one for a random RevenueCat id", async () => {
    const buyer = await member();
    const view = await api<PacksResponse>(packs, "GET", "/api/wallet/packs", { member: buyer });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ salesOpen: true, available: true, account: "personal", consentVersion: "2026-10" });
    expect(view.body.packs.map((pack) => [pack.id, pack.priceMinor, pack.credits])).toEqual([
      ["mad_30", 3_000, 30],
      ["mad_100", 10_000, 110],
      ["mad_200", 20_000, 230],
      ["mad_500", 50_000, 600],
    ]);

    const result = await pay(buyer, order());
    expect(result.status).toBe(200);
    const url = new URL(result.body.url);
    expect(`${url.origin}${url.pathname}`).toMatch(/^https:\/\/pay\.rev\.cat\/sandbox-token\/[0-9a-f-]{36}$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ currency: "MAD", package_id: "credits_100_mad", skip_purchase_success: "true" });
    const account = (await billingAccountRef(buyer.uid).get()).data();
    expect(account).toMatchObject({ kind: "personal", ownerUid: buyer.uid, lastCheckout: { packId: "mad_100", consentVersion: "2026-10" } });
    expect(account?.rcAppUserId).not.toBe(buyer.uid);
    expect(url.pathname.endsWith(account?.rcAppUserId as string)).toBe(true);

    // A second checkout keeps the same RevenueCat customer.
    expect(await checkoutOf(buyer, "mad_30", 3_000)).toBe(account?.rcAppUserId);
  });

  it("refuses a closed shop, a changed price, a missing consent, a failed challenge and a missing CSRF token", async () => {
    const buyer = await member();
    flags.salesEnabled = false;
    const closed = await pay(buyer, order());
    expect(closed.status).toBe(403);
    expect(code(closed.body)).toBe("sales_closed");
    expect((await billingAccountRef(buyer.uid).get()).exists).toBe(false);
    flags.salesEnabled = true;

    const repriced = await pay(buyer, order("mad_100", 9_900));
    expect(repriced.status).toBe(409);
    expect(code(repriced.body)).toBe("price_changed");
    expect(code((await pay(buyer, order("mad_999", 10_000))).body)).toBe("price_changed");
    expect((await pay(buyer, { ...order(), acceptTerms: false })).status).toBe(400);
    expect(code((await pay(buyer, { ...order(), turnstileToken: "refused" })).body)).toBe("turnstile_failed");
    const forged = await api(checkout, "POST", "/api/wallet/packs", { member: buyer, body: order(), csrf: false });
    expect(forged.status).toBe(403);
    expect((await billingAccountRef(buyer.uid).get()).exists).toBe(false);
  });

  it("bills a shop owner's checkout to the shop", async () => {
    const owner = await member();
    await setClaims(owner.uid, { role: "pro", proId: "shpk2345", proRole: "owner" });
    const minted = await createSessionForUid(owner.uid);
    owner.jar.cookies.set("__Host-session", minted.cookie);
    owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
    await checkoutOf(owner);
    expect((await billingAccountRef("pro_shpk2345").get()).data()).toMatchObject({ kind: "shop", ownerUid: owner.uid, proId: "shpk2345" });
    expect((await billingAccountRef(owner.uid).get()).exists).toBe(false);
  });
});

describe("RevenueCat webhook", () => {
  it("refuses a wrong Authorization value or signature, and ignores the other environment", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const envelope = rcEvent("NON_RENEWING_PURCHASE", appUserId, `txn_${randomUUID()}`);
    store.purchases = [owned(envelope.event.transaction_id)];
    expect((await deliver(envelope, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await deliver(envelope, { secret: "another-secret" })).status).toBe(401);
    expect((await deliver(envelope, { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect(await getWallet(buyer.uid)).toBeNull();

    const production = rcEvent("NON_RENEWING_PURCHASE", appUserId, `txn_${randomUUID()}`, { environment: "PRODUCTION" });
    expect((await deliver(production)).status).toBe(200);
    expect((await billingEventRef(production.event.id).get()).exists).toBe(false);
    expect(await getWallet(buyer.uid)).toBeNull();
  });

  it("credits a pack once, with its order and the consent given at checkout", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    const envelope = rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId);
    store.purchases = [owned(transactionId)];

    expect((await deliver(envelope)).status).toBe(200);
    expect(await getWallet(buyer.uid)).toMatchObject({ balance: 110, frozen: false });
    expect(await getOrder(transactionId)).toMatchObject({
      kind: "pack",
      accountId: buyer.uid,
      packId: "mad_100",
      credits: { paid: 100, bonus: 10 },
      currency: "MAD",
      amountMinor: 10_000,
      status: "paid",
      environment: "SANDBOX",
      taxJurisdiction: "MA",
      locationEvidence: { countryCode: "MA" },
      consent: { version: "2026-10" },
      eventId: envelope.event.id,
    });
    expect((await ledgerRef(buyer.uid, `purchase_${transactionId}`).get()).data()).toMatchObject({ reason: "purchase", delta: 110, paidPart: 100, bonusPart: 10, balanceAfter: 110, price: 100, refs: { orderId: transactionId }, actorUid: "system" });
    expect((await billingEventRef(envelope.event.id).get()).data()).toMatchObject({ status: "processed", outcome: "credited" });

    // The same event delivered again, then another event for the same transaction: credited once.
    expect((await deliver(envelope)).status).toBe(200);
    expect((await deliver(rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId))).status).toBe(200);
    expect((await getWallet(buyer.uid))?.balance).toBe(110);
    expect(alert).not.toHaveBeenCalled();
  });

  it("waits for RevenueCat to show the purchase: the delivery fails, its retry credits", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    const envelope = rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId);

    expect((await deliver(envelope)).status).toBe(500);
    expect((await billingEventRef(envelope.event.id).get()).data()).toMatchObject({ status: "failed", attempts: 1 });
    expect(await getWallet(buyer.uid)).toBeNull();

    store.purchases = [owned(transactionId)];
    expect((await deliver(envelope)).status).toBe(200);
    expect((await getWallet(buyer.uid))?.balance).toBe(110);
    expect((await billingEventRef(envelope.event.id).get()).data()).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("does not credit a pack paid for an unknown customer, product or currency, alerts each, and ends its refund", async () => {
    const stranger = rcEvent("NON_RENEWING_PURCHASE", randomUUID(), `txn_${randomUUID()}`);
    expect((await deliver(stranger)).status).toBe(200);
    expect((await billingEventRef(stranger.event.id).get()).data()).toMatchObject({ status: "ignored", outcome: "unknown_customer" });

    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const unknown = rcEvent("NON_RENEWING_PURCHASE", appUserId, `txn_${randomUUID()}`, { product_id: "joutiya_credits_999_mad" });
    expect((await deliver(unknown)).status).toBe(200);
    expect((await billingEventRef(unknown.event.id).get()).data()).toMatchObject({ status: "ignored", outcome: "unknown_product" });
    const transactionId = `txn_${randomUUID()}`;
    store.purchases = [owned(transactionId)];
    const euros = rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId, { currency: "EUR", price_in_purchased_currency: 1 });
    expect((await deliver(euros)).status).toBe(200);
    expect((await billingEventRef(euros.event.id).get()).data()).toMatchObject({ status: "ignored", outcome: "wrong_currency" });
    expect(await getWallet(buyer.uid)).toBeNull();
    expect(await getOrder(transactionId)).toBeNull();
    // One alert per event (the hourly dedupe of a title does not hide the second loss).
    const alerts = vi.mocked(alert).mock.calls.map(([event]) => event);
    expect(alerts.map((event) => event.severity)).toEqual(["P1", "P1", "P1"]);
    expect(new Set(alerts.map((event) => event.title)).size).toBe(3);

    // The admin refunds it: the refund finds no order and ends without a debit or another alert.
    store.purchases = [owned(transactionId, "refunded")];
    const refund = rcEvent("CANCELLATION", appUserId, transactionId, { cancel_reason: "CUSTOMER_SUPPORT", currency: "EUR" });
    expect((await deliver(refund)).status).toBe(200);
    expect((await billingEventRef(refund.event.id).get()).data()).toMatchObject({ status: "ignored", outcome: "never_credited" });
    expect(await getWallet(buyer.uid)).toBeNull();
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it("refunds a spent pack: the wallet goes negative, freezes, and the account is flagged", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    store.purchases = [owned(transactionId)];
    expect((await deliver(rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId))).status).toBe(200);
    // 100 of the 110 credits spent meanwhile.
    const now = new Date();
    await setWallet(buyer.uid, { balance: 10, frozen: false, planCredits: 0, allowances: { featured: 0 }, createdAt: now, updatedAt: now });

    // A refund RevenueCat does not show yet debits nothing and goes again later.
    const refund = rcEvent("CANCELLATION", appUserId, transactionId, { cancel_reason: "CUSTOMER_SUPPORT", price_in_purchased_currency: -100 });
    expect((await deliver(refund)).status).toBe(500);
    expect((await billingEventRef(refund.event.id).get()).data()).toMatchObject({ status: "failed", attempts: 1, lastError: "refund not visible in RevenueCat yet" });
    expect((await getWallet(buyer.uid))?.balance).toBe(10);

    store.purchases = [owned(transactionId, "refunded")];
    expect((await deliver(refund)).status).toBe(200);
    expect(await getWallet(buyer.uid)).toMatchObject({ balance: -100, frozen: true });
    expect(await getOrder(transactionId)).toMatchObject({ status: "refunded", refundEventId: refund.event.id });
    expect((await ledgerRef(buyer.uid, `refund_${transactionId}`).get()).data()).toMatchObject({ reason: "refund", delta: -110, paidPart: -100, bonusPart: -10, balanceAfter: -100 });
    expect((await billingAccountRef(buyer.uid).get()).data()?.flaggedAt).toBeDefined();
    expect(vi.mocked(alert).mock.calls.map(([event]) => event.title)).toEqual([`Porte-monnaie négatif après un remboursement (${buyer.uid})`]);

    // Delivered again: debited once.
    expect((await deliver(rcEvent("CANCELLATION", appUserId, transactionId, { cancel_reason: "CUSTOMER_SUPPORT" }))).status).toBe(200);
    expect((await getWallet(buyer.uid))?.balance).toBe(-100);
  });

  it("keeps a purchase refunded before it was processed without crediting it", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    store.purchases = [owned(transactionId, "refunded")];
    expect((await deliver(rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId))).status).toBe(200);
    expect(await getOrder(transactionId)).toMatchObject({ status: "refunded", credits: { paid: 100, bonus: 10 } });
    expect(await getWallet(buyer.uid)).toBeNull();
    expect((await deliver(rcEvent("CANCELLATION", appUserId, transactionId, { cancel_reason: "CUSTOMER_SUPPORT" }))).status).toBe(200);
    expect(await getWallet(buyer.uid)).toBeNull();
  });
});

describe("billing reconciliation", () => {
  const HOUR_MS = 3_600_000;
  /** RevenueCat lists each customer's own purchases; its product ids are its own (`prod...`). */
  const deps = (appUserId: string) => ({
    listPurchases: vi.fn(async (customer: string) => (customer === appUserId ? store.purchases : [])),
    storeIdentifier: vi.fn(async (productId: string) => (productId === "prod_credits_100" ? "joutiya_credits_100_mad" : "unknown")),
  });
  const listed = (transactionId: string, status = "owned"): RevenueCatPurchase => ({ ...owned(transactionId, status), productId: "prod_credits_100", store: "rc_billing", country: "MA", purchasedAt: new Date(Date.now() - HOUR_MS) });

  it("credits a pack whose webhook never came, once, then its refund", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    store.purchases = [listed(transactionId)];

    expect(await reconcileBilling(new Date(), deps(appUserId))).toMatchObject({ packs: 1, failed: 0 });
    expect(await getWallet(buyer.uid)).toMatchObject({ balance: 110 });
    expect(await getOrder(transactionId)).toMatchObject({ packId: "mad_100", currency: "MAD", status: "paid", store: "RC_BILLING", taxJurisdiction: "MA", locationEvidence: { countryCode: "MA" }, consent: { version: "2026-10" } });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: "Paiements rattrapés cette nuit (1)" }));

    // A second night finds the order; the webhook arriving late credits nothing more.
    expect(await reconcileBilling(new Date(), deps(appUserId))).toMatchObject({ packs: 0, failed: 0 });
    expect((await deliver(rcEvent("NON_RENEWING_PURCHASE", appUserId, transactionId))).status).toBe(200);
    expect((await getWallet(buyer.uid))?.balance).toBe(110);

    store.purchases = [listed(transactionId, "refunded")];
    expect(await reconcileBilling(new Date(), deps(appUserId))).toMatchObject({ packs: 1, failed: 0 });
    expect(await getWallet(buyer.uid)).toMatchObject({ balance: 0 });
    expect(await getOrder(transactionId)).toMatchObject({ status: "refunded" });
  });

  it("processes again an event the queue left failed, and alerts what it cannot solve", async () => {
    const buyer = await member();
    const appUserId = await checkoutOf(buyer);
    const transactionId = `txn_${randomUUID()}`;
    const eventId = randomUUID();
    const receivedAt = new Date(Date.now() - 4 * HOUR_MS);
    await createBillingEvent({ source: "revenuecat", eventId, type: "NON_RENEWING_PURCHASE", environment: "SANDBOX", appUserId, productId: "joutiya_credits_100_mad", transactionId, store: "RC_BILLING", currency: "MAD", amountMinor: 10_000, countryCode: "MA", kind: "pack", status: "failed", attempts: 8, lastError: "purchase not visible in RevenueCat yet", receivedAt });
    store.purchases = [listed(transactionId)];

    expect(await reconcileBilling(new Date(), deps(appUserId))).toMatchObject({ swept: 1, packs: 0, failed: 0 });
    expect((await billingEventRef(eventId).get()).data()).toMatchObject({ status: "processed", outcome: "credited", attempts: 9 });
    expect(await getOrder(transactionId)).toMatchObject({ eventId, amountMinor: 10_000 });

    // A purchase of a product RevenueCat names otherwise: not credited, alerted.
    const unknown = `txn_${randomUUID()}`;
    store.purchases = [{ ...listed(unknown), productId: "prod_other" }];
    vi.mocked(alert).mockClear();
    const run = await reconcileBilling(new Date(), deps(appUserId));
    expect(run).toMatchObject({ packs: 0, failed: 1 });
    expect(run.problems[0]).toContain(unknown);
    expect(await getOrder(unknown)).toBeNull();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: expect.stringContaining("Rapprochement des paiements") }));
  });
});
