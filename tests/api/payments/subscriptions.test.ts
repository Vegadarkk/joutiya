import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "@/lib/config/runtime";
import type * as RevenueCatApiModule from "@/lib/payments/revenuecat-api";
import type { RevenueCatSubscription } from "@/lib/payments/revenuecat-api";
import type * as StripeApiModule from "@/lib/payments/stripe-api";
import type * as QuotaModule from "@/lib/quota";

// Pro subscriptions (phase 7 design §7): the plan page and the Stripe Checkout of a verified shop
// (owner only, sales gate, one running plan), the Customer Portal, the Stripe webhook (signature,
// environment, the receipt handed to RevenueCat, the grace of a failed payment) and the sync from
// RevenueCat: the plan's lifecycle and quotas, the month's grant reset once per period, the
// downgrade at expiry that pauses the listings over the quota, which a new plan leaves paused; the
// invoices list; the nightly job (re-sync, end of a Stripe grace, end of the launch offer).

const flags = vi.hoisted(() => ({ salesEnabled: true, proSignupEnabled: true, paymentInstallmentsEnabled: false }));
const offer = vi.hoisted(() => ({ endsAt: null as string | null }));
const store = vi.hoisted(() => ({ subscriptions: [] as RevenueCatSubscription[] }));
/** Resend headroom seen by the launch-offer run (null = counter unreadable, the per-run cap applies). */
const mailRoom = vi.hoisted(() => ({ value: null as number | null }));
const stripe = vi.hoisted(() => ({
  calls: [] as { method: string; path: string; params: Record<string, unknown>; idempotencyKey?: string }[],
  subscriptionStatus: "active",
  sessionStatus: "open",
  /** GET /v1/events?delivery_success=false and GET /v1/subscriptions (the reconciliation's lists). */
  undelivered: [] as unknown[],
  running: [] as { id: string; status: string; customer: string; created?: number; metadata?: Record<string, string> }[],
}));

vi.mock("@/lib/config/runtime", async (importOriginal) => {
  const { DEFAULT_PRICING } = await import("@/config/pricing");
  const plans = {
    ...DEFAULT_PRICING.plans,
    essentiel: { ...DEFAULT_PRICING.plans.essentiel, stripePrices: { monthly: "price_EssentielMonthly", yearly: "price_EssentielYearly" } },
    business: { ...DEFAULT_PRICING.plans.business, stripePrices: { monthly: "price_BusinessMonthly", yearly: "price_BusinessYearly" } },
  };
  return {
    ...(await importOriginal<typeof RuntimeModule>()),
    getFlags: vi.fn(async () => ({ ...flags })),
    getPricing: vi.fn(async () => ({ ...DEFAULT_PRICING, plans, launchOffer: { ...DEFAULT_PRICING.launchOffer, endsAt: offer.endsAt } })),
  };
});
vi.mock("@/lib/payments/revenuecat-api", async (importOriginal) => ({
  ...(await importOriginal<typeof RevenueCatApiModule>()),
  listCustomerSubscriptions: vi.fn(async () => store.subscriptions),
  postStripeReceipt: vi.fn(async () => undefined),
}));
vi.mock("@/lib/payments/stripe-api", async (importOriginal) => ({
  ...(await importOriginal<typeof StripeApiModule>()),
  stripeRequest: vi.fn(async (method: string, path: string, params: Record<string, unknown> = {}, options: { idempotencyKey?: string } = {}) => {
    stripe.calls.push({ method, path, params, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
    // One customer per shop: `customer_pro_{proId}` → `cus_{proId}`.
    if (path === "/v1/customers") return { id: `cus_${options.idempotencyKey?.split("_").pop()}` };
    if (path.startsWith("/v1/customers/")) return { id: path.split("/").pop() };
    if (path === "/v1/checkout/sessions") return { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
    if (path.endsWith("/expire")) return { status: "expired" };
    if (path.startsWith("/v1/checkout/sessions/")) return { status: stripe.sessionStatus };
    if (path.startsWith("/v1/subscriptions/")) return { status: stripe.subscriptionStatus };
    if (path === "/v1/billing_portal/sessions") return { url: "https://billing.stripe.com/p/session/test_1" };
    if (path === "/v1/invoices") {
      const invoice = { id: "in_Test1", number: "JOUT-0001", created: 1_790_000_000, total: 70_800, currency: "mad", hosted_invoice_url: "https://invoice.stripe.com/i/test", invoice_pdf: "https://pay.stripe.com/invoice/test/pdf" };
      return { data: [{ ...invoice, status: "paid" }, { ...invoice, id: "in_Draft", status: "draft" }], has_more: false };
    }
    if (path === "/v1/events") return { data: stripe.undelivered, has_more: false };
    if (path === "/v1/subscriptions") return { data: stripe.running, has_more: false };
    throw new Error(`unexpected Stripe call ${method} ${path}`);
  }),
}));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof QuotaModule>()), headroom: vi.fn(async () => mailRoom.value) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as resume } from "@/app/api/listings/[id]/resume/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { GET as invoices } from "@/app/api/billing/invoices/route";
import { POST as portal } from "@/app/api/billing/portal/route";
import { GET as subscriptionPage } from "@/app/api/billing/subscription/route";
import { POST as rcWebhook } from "@/app/api/webhooks/revenuecat/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { BillingRedirectResponse, InvoicesResponse, SubscriptionResponse } from "@/lib/contracts/payments";
import { alert } from "@/lib/alert";
import { getBillingAccount, getSubscription } from "@/lib/db/repositories/billing";
import { getListing } from "@/lib/db/repositories/listings";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { getWallet, ledgerRef, setWallet } from "@/lib/db/repositories/wallets";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { postStripeReceipt } from "@/lib/payments/revenuecat-api";
import { expectedSignature } from "@/lib/payments/revenuecat-webhook";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { reconcileBilling } from "@/lib/payments/reconcile";
import { proPlansNightly } from "@/worker/jobs/pro-plans";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Member } from "../listings/helpers";

const RC_AUTH = "Bearer rc-test-authorization";
const RC_SECRET = "rc-test-signing-secret";
const STRIPE_SECRET = "whsec_test_secret";
const VARS = {
  REVENUECAT_WEBHOOK_AUTH: RC_AUTH,
  REVENUECAT_WEBHOOK_HMAC_SECRET: RC_SECRET,
  REVENUECAT_PROJECT_ID: "proj-test",
  REVENUECAT_SECRET_API_KEY: "sk-test",
  REVENUECAT_STRIPE_PUBLIC_KEY: "strp-test",
  STRIPE_SECRET_KEY: "sk_test_joutiya",
  STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
};

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
  offer.endsAt = null;
  store.subscriptions = [];
  stripe.calls = [];
  stripe.subscriptionStatus = "active";
  stripe.sessionStatus = "open";
  stripe.undelivered = [];
  stripe.running = [];
  vi.mocked(alert).mockClear();
  vi.mocked(postStripeReceipt).mockClear();
});

const code = (body: unknown) => (body as ErrorBody).error.code;
const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");

async function signIn(owner: Member, claims: Parameters<typeof setClaims>[1]): Promise<void> {
  await setClaims(owner.uid, claims);
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
}

/** A verified shop on the launch offer, signed in as its owner. */
async function shop(owner: Member, extra: Partial<ProProfileDoc> = {}): Promise<string> {
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Atlas Auto",
    slug: `atlas-auto-${proId}`,
    description: "Voitures d'occasion contrôlées.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: DEFAULT_PRICING.pro.essentiel,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await signIn(owner, { role: "pro", proId, proRole: "owner" });
  return proId;
}

const startCheckout = (owner: Member, body: unknown) => api<BillingRedirectResponse & ErrorBody>(checkout, "POST", "/api/billing/checkout", { member: owner, body });
const plan = (planId = "business", interval = "monthly") => ({ plan: planId, interval, acceptTerms: true, locale: "fr" });

/** Opens a first checkout and answers the shop's RevenueCat app user id. */
async function appUserOf(owner: Member, proId: string, planId = "business"): Promise<string> {
  expect((await startCheckout(owner, plan(planId))).status).toBe(200);
  const account = await getBillingAccount(`pro_${proId}`);
  return account!.rcAppUserId;
}

function rcSubscription(extra: Partial<RevenueCatSubscription> = {}): RevenueCatSubscription {
  const start = new Date(Date.now() - DAY_MS);
  return {
    id: "sub_rc_1",
    status: "active",
    givesAccess: true,
    willRenew: true,
    periodStart: start,
    periodEnd: new Date(start.getTime() + 30 * DAY_MS),
    store: "stripe",
    storeSubscriptionId: "sub_Stripe1",
    environment: "sandbox",
    entitlements: ["business"],
    ...extra,
  };
}

/** A RevenueCat subscription event, as its webhook delivers it. */
async function rcDeliver(type: string, appUserId: string) {
  const envelope = {
    api_version: "1.0",
    event: { id: randomUUID(), type, environment: "SANDBOX", app_user_id: appUserId, original_app_user_id: appUserId, product_id: "joutiya_business_monthly", store: "STRIPE", event_timestamp_ms: Date.now() },
  };
  const t = Math.floor(Date.now() / 1000);
  const signature = expectedSignature(RC_SECRET, t, JSON.stringify(envelope));
  const result = await api<ErrorBody>(rcWebhook, "POST", "/api/webhooks/revenuecat", { body: envelope, origin: null, headers: { authorization: RC_AUTH, "x-revenuecat-webhook-signature": `t=${t},v1=${signature}` } });
  expect(result.status).toBe(200);
}

/** A Stripe event, signed like Stripe's webhook (`t=..,v1=..`). */
async function stripeDeliver(type: string, object: Record<string, unknown>, options: { livemode?: boolean; secret?: string } = {}) {
  const event = { id: `evt_${randomUUID().replace(/-/g, "")}`, object: "event", type, livemode: options.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object } };
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", options.secret ?? STRIPE_SECRET)
    .update(`${t}.${JSON.stringify(event)}`)
    .digest("hex");
  return api<ErrorBody & { received?: boolean }>(stripeWebhook, "POST", "/api/webhooks/stripe", { body: event, origin: null, headers: { "stripe-signature": `t=${t},v1=${signature}` } });
}

/** A published listing of `owner`, sorted `ageDays` ago (published before the shop's claims). */
async function published(owner: Member): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  expect((await api(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).body).toMatchObject({ status: "published" });
  return id;
}

describe("plan checkout", () => {
  it("opens the Stripe Checkout of a verified shop's plan with its customer and RevenueCat id", async () => {
    const owner = await member();
    const proId = await shop(owner);

    const page = await api<SubscriptionResponse>(subscriptionPage, "GET", "/api/billing/subscription", { member: owner });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ salesOpen: true, available: true, lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", subscription: null, consentVersion: "2026-10" });
    expect(page.body.plans.map((offer) => [offer.id, offer.priceMinor.monthly, offer.credits, offer.featured, offer.activeListings, offer.available])).toEqual([
      ["essentiel", 24_900, 30, 0, 50, true],
      ["business", 59_000, 100, 4, 250, true],
    ]);

    const opened = await startCheckout(owner, plan("business", "yearly"));
    expect(opened.status).toBe(200);
    expect(opened.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const account = await getBillingAccount(`pro_${proId}`);
    expect(account).toMatchObject({ kind: "shop", ownerUid: owner.uid, proId, stripeCustomerId: `cus_${proId}`, lastPlanCheckout: { plan: "business", interval: "yearly", consentVersion: "2026-10" } });
    const [customer, session] = stripe.calls;
    expect(customer).toMatchObject({ method: "POST", path: "/v1/customers", idempotencyKey: `customer_pro_${proId}` });
    expect(customer!.params).toMatchObject({
      name: "Atlas Auto",
      metadata: { accountId: `pro_${proId}`, app_user_id: account!.rcAppUserId },
      invoice_settings: { custom_fields: [{ name: "ICE", value: "001234567000089" }, { name: "IF", value: "1234567" }, { name: "RC", value: "12345" }] },
    });
    expect(session).toMatchObject({ method: "POST", path: "/v1/checkout/sessions" });
    expect(session!.params).toMatchObject({
      mode: "subscription",
      customer: `cus_${proId}`,
      line_items: [{ price: "price_BusinessYearly", quantity: 1 }],
      metadata: { accountId: `pro_${proId}`, app_user_id: account!.rcAppUserId, env: "dev" },
      subscription_data: { metadata: { app_user_id: account!.rcAppUserId, env: "dev" } },
    });
    expect(session!.params.success_url).toMatch(/\/fr\/pro\/abonnement\?abonnement=ok$/);
    expect(session!.idempotencyKey).toMatch(new RegExp(`^checkout_pro_${proId}_business_yearly_fr_price_BusinessYearly_\\d{4}-\\d{2}-\\d{2}$`));
    expect((await getBillingAccount(`pro_${proId}`))?.lastPlanCheckout?.sessionId).toBe("cs_test_1");

    // A second checkout expires the first session (one plan billed), keeps the customer and the
    // RevenueCat id, and updates the customer.
    stripe.calls = [];
    expect((await startCheckout(owner, plan("essentiel"))).status).toBe(200);
    expect(stripe.calls.map((call) => `${call.method} ${call.path}`).slice(0, 3)).toEqual(["GET /v1/checkout/sessions/cs_test_1", "POST /v1/checkout/sessions/cs_test_1/expire", `POST /v1/customers/cus_${proId}`]);
    expect(stripe.calls[2]!.idempotencyKey).toBeUndefined();
    expect((await getBillingAccount(`pro_${proId}`))?.rcAppUserId).toBe(account!.rcAppUserId);

    const managed = await api<BillingRedirectResponse>(portal, "POST", "/api/billing/portal", { member: owner, body: { locale: "ar" } });
    expect(managed.status).toBe(200);
    expect(managed.body.url).toBe("https://billing.stripe.com/p/session/test_1");
    expect(stripe.calls.at(-1)).toMatchObject({ path: "/v1/billing_portal/sessions", params: { customer: `cus_${proId}` } });
    expect(stripe.calls.at(-1)!.params.return_url).toMatch(/\/ar\/pro\/abonnement$/);

    // The last session was paid but its plan is not synced yet: no second plan.
    stripe.sessionStatus = "complete";
    const paidTwice = await startCheckout(owner, plan("business"));
    expect(paidTwice.status).toBe(409);
    expect(code(paidTwice.body)).toBe("already_subscribed");
  });

  it("is refused while sales are closed, to an editor, an individual, an unverified shop and without consent", async () => {
    const owner = await member();
    const proId = await shop(owner);
    flags.salesEnabled = false;
    const closed = await startCheckout(owner, plan());
    expect(closed.status).toBe(403);
    expect(code(closed.body)).toBe("sales_closed");
    flags.salesEnabled = true;

    expect((await startCheckout(owner, { ...plan(), acceptTerms: false })).status).toBe(400);
    expect((await startCheckout(owner, { ...plan(), plan: "premium" })).status).toBe(400);
    expect((await api(checkout, "POST", "/api/billing/checkout", { member: owner, body: plan(), csrf: false })).status).toBe(403);

    const noCustomer = await api<ErrorBody>(portal, "POST", "/api/billing/portal", { member: owner, body: { locale: "fr" } });
    expect(noCustomer.status).toBe(409);
    expect(code(noCustomer.body)).toBe("no_billing_customer");

    await signIn(owner, { role: "pro", proId, proRole: "editor" });
    const editor = await startCheckout(owner, plan());
    expect(editor.status).toBe(403);
    expect(code(editor.body)).toBe("billing_owner_only");

    const individual = await member();
    expect((await startCheckout(individual, plan())).status).toBe(404);
    expect((await api(subscriptionPage, "GET", "/api/billing/subscription", { member: individual })).status).toBe(404);

    const pending = await member();
    await shop(pending, { lifecycle: "pending_verification", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none, kybc: { status: "submitted", iceFormatOk: true, uploadIds: [] } });
    const unverified = await startCheckout(pending, plan());
    expect(unverified.status).toBe(409);
    expect(code(unverified.body)).toBe("pro_not_verified");
    expect(stripe.calls).toEqual([]);
  });
});

describe("subscription sync", () => {
  it("activates the plan from RevenueCat and resets the month's grant once per period", async () => {
    const owner = await member();
    const proId = await shop(owner);
    const accountId = `pro_${proId}`;
    const appUserId = await appUserOf(owner, proId);
    const first = rcSubscription();
    store.subscriptions = [first];

    await rcDeliver("INITIAL_PURCHASE", appUserId);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "business", planSource: "subscription", quotas: DEFAULT_PRICING.pro.business });
    expect(await getSubscription(accountId)).toMatchObject({ plan: "business", interval: "monthly", status: "active", rcSubscriptionId: "sub_rc_1", storeSubscriptionId: "sub_Stripe1", environment: "SANDBOX", willRenew: true });
    expect(await getWallet(accountId)).toMatchObject({ planCredits: 100, allowances: { featured: 4 } });
    const grantId = `grant_sub_rc_1_business_${first.periodStart.getTime()}`;
    expect((await ledgerRef(accountId, grantId).get()).data()).toMatchObject({ reason: "plan_grant", planCreditsDelta: 100, actorUid: "system" });

    // Spent credits stay spent within the period: another event of the same period grants nothing.
    await setWallet(accountId, { ...(await getWallet(accountId))!, planCredits: 40 });
    await rcDeliver("UNCANCELLATION", appUserId);
    expect((await getWallet(accountId))?.planCredits).toBe(40);

    const page = await api<SubscriptionResponse>(subscriptionPage, "GET", "/api/billing/subscription", { member: owner });
    expect(page.body).toMatchObject({ lifecycle: "active", plan: "business", subscription: { plan: "business", interval: "monthly", status: "active", willRenew: true } });
    const again = await startCheckout(owner, plan("essentiel"));
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe("already_subscribed");

    // The renewal resets the plan credits to the plan's grant (not added to what is left).
    const renewed = rcSubscription({ periodStart: first.periodEnd!, periodEnd: new Date(first.periodEnd!.getTime() + 30 * DAY_MS) });
    store.subscriptions = [renewed];
    await rcDeliver("RENEWAL", appUserId);
    expect((await getWallet(accountId))?.planCredits).toBe(100);
    expect((await ledgerRef(accountId, `grant_sub_rc_1_business_${renewed.periodStart.getTime()}`).get()).exists).toBe(true);
  });

  it("puts the shop in grace on a failed payment, downgrades it at expiry and pauses then resumes its listings", async () => {
    const owner = await member();
    const listingId = await published(owner);
    const proId = await shop(owner);
    const accountId = `pro_${proId}`;
    const appUserId = await appUserOf(owner, proId, "essentiel");
    store.subscriptions = [rcSubscription({ entitlements: ["essentiel"] })];

    // Stripe's subscription event hands the subscription to RevenueCat, then syncs.
    const created = await stripeDeliver("customer.subscription.created", { id: "sub_Stripe1", object: "subscription", customer: `cus_${proId}`, metadata: { app_user_id: appUserId, accountId } });
    expect(created.status).toBe(200);
    expect(postStripeReceipt).toHaveBeenCalledWith(appUserId, "sub_Stripe1");
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "essentiel", planSource: "subscription" });

    // Refused deliveries change nothing.
    const forged = await stripeDeliver("invoice.payment_failed", { id: "in_1", object: "invoice", customer: `cus_${proId}`, subscription: "sub_Stripe1" }, { secret: "whsec_other" });
    expect(forged.status).toBe(400);
    expect(code(forged.body)).toBe("invalid_signature");
    const live = await stripeDeliver("invoice.payment_failed", { id: "in_1", object: "invoice", customer: `cus_${proId}`, subscription: "sub_Stripe1" }, { livemode: true });
    expect(live.status).toBe(200);
    expect((await getProProfile(proId))?.lifecycle).toBe("active");

    // A failure delivered after the payment that fixed it opens nothing.
    expect((await stripeDeliver("invoice.payment_failed", { id: "in_0", object: "invoice", customer: `cus_${proId}`, subscription: "sub_Stripe1" })).status).toBe(200);
    expect((await getProProfile(proId))?.lifecycle).toBe("active");

    // A failed payment opens the grace at once, while RevenueCat still lists the plan as active.
    stripe.subscriptionStatus = "past_due";
    const failed = await stripeDeliver("invoice.payment_failed", { id: "in_1", object: "invoice", customer: `cus_${proId}`, subscription: "sub_Stripe1" });
    expect(failed.status).toBe(200);
    const inGrace = await getProProfile(proId);
    expect(inGrace).toMatchObject({ lifecycle: "grace", plan: "essentiel", quotas: DEFAULT_PRICING.pro.essentiel });
    expect(inGrace!.graceUntil!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY_MS);

    // RevenueCat's billing issue keeps the grace running.
    store.subscriptions = [rcSubscription({ entitlements: ["essentiel"], status: "in_billing_retry", givesAccess: false })];
    await rcDeliver("BILLING_ISSUE", appUserId);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "grace", graceUntil: inGrace!.graceUntil });
    expect((await getSubscription(accountId))?.status).toBe("billing_issue");

    // Expiry: the plan ends, the shop keeps no quota and its listing is paused.
    store.subscriptions = [rcSubscription({ entitlements: ["essentiel"], status: "expired", givesAccess: false, willRenew: false })];
    await rcDeliver("EXPIRATION", appUserId);
    const downgraded = await getProProfile(proId);
    expect(downgraded).toMatchObject({ lifecycle: "downgraded", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none });
    expect(downgraded!.graceUntil).toBeUndefined();
    expect(await getSubscription(accountId)).toMatchObject({ status: "expired", willRenew: false });
    expect(await getListing(listingId)).toMatchObject({ status: "paused", pausedReason: "quota", adsEligible: false });

    // A new plan does not republish it (spec §5): the owner resumes it, within the new quota.
    store.subscriptions = [rcSubscription({ id: "sub_rc_2", storeSubscriptionId: "sub_Stripe2", entitlements: ["essentiel"] })];
    await rcDeliver("INITIAL_PURCHASE", appUserId);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "essentiel", planSource: "subscription" });
    expect(await getListing(listingId)).toMatchObject({ status: "paused", pausedReason: "quota" });
    const resumed = await api(resume, "POST", `/api/listings/${listingId}/resume`, { member: owner, body: {} });
    expect(resumed.status).toBe(200);
    expect(await getListing(listingId)).toMatchObject({ status: "published" });
  });

  it("alerts on a Stripe subscription of an unknown customer and ignores a pack's checkout", async () => {
    const unknown = await stripeDeliver("customer.subscription.updated", { id: "sub_Lost", object: "subscription", customer: "cus_Unknown" });
    expect(unknown.status).toBe(200);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: expect.stringContaining("Abonnement Stripe sans boutique") }));
    expect(postStripeReceipt).not.toHaveBeenCalled();

    vi.mocked(alert).mockClear();
    const pack = await stripeDeliver("checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "payment", customer: "cus_Unknown" });
    expect(pack.status).toBe(200);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("invoices", () => {
  it("lists the shop's sent invoices to its owner only", async () => {
    const owner = await member();
    const proId = await shop(owner);
    expect((await api<InvoicesResponse>(invoices, "GET", "/api/billing/invoices", { member: owner })).body).toEqual({ invoices: [] });
    await appUserOf(owner, proId);
    const listed = await api<InvoicesResponse>(invoices, "GET", "/api/billing/invoices", { member: owner });
    expect(listed.status).toBe(200);
    expect(listed.body.invoices.map((invoice) => [invoice.id, invoice.status, invoice.currency])).toEqual([["in_Test1", "paid", "MAD"]]);
    expect(stripe.calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/invoices", params: { customer: `cus_${proId}`, limit: 24 } });
    const individual = await member();
    expect((await api<ErrorBody>(invoices, "GET", "/api/billing/invoices", { member: individual })).status).toBe(404);
  });
});

describe("nightly plans job", () => {
  const mailsTo = (owner: Member) => vi.mocked(sendMail).mock.calls.map(([mail]) => mail).filter((mail) => mail.to === owner.email);

  it("keeps a Stripe grace while the payment is due, ends it at its date and re-activates a fixed payment", async () => {
    const owner = await member();
    const listingId = await published(owner);
    const proId = await shop(owner);
    const appUserId = await appUserOf(owner, proId, "essentiel");
    store.subscriptions = [rcSubscription({ entitlements: ["essentiel"] })];
    await rcDeliver("INITIAL_PURCHASE", appUserId);
    stripe.subscriptionStatus = "past_due";
    expect((await stripeDeliver("invoice.payment_failed", { id: "in_1", object: "invoice", customer: `cus_${proId}`, subscription: "sub_Stripe1" })).status).toBe(200);
    expect((await getProProfile(proId))?.lifecycle).toBe("grace");

    // RevenueCat still shows the plan paid: the night does not undo the grace, and moves the
    // subscription to the back of its queue.
    const queued = (await getSubscription(`pro_${proId}`))!.syncedAt;
    await proPlansNightly(new Date(Date.now() + 60_000));
    expect((await getProProfile(proId))?.lifecycle).toBe("grace");
    expect((await getSubscription(`pro_${proId}`))!.syncedAt.getTime()).toBeGreaterThan(queued.getTime());

    // Past its date, the grace ends as an expiry would.
    await proProfileRef(proId).update({ graceUntil: new Date(Date.now() - 60_000) });
    expect((await proPlansNightly()).graceEnded).toBeGreaterThanOrEqual(1);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "downgraded", plan: "none", planSource: "none" });
    expect(await getListing(listingId)).toMatchObject({ status: "paused", pausedReason: "quota" });
    await proPlansNightly();
    expect((await getProProfile(proId))?.lifecycle).toBe("downgraded");

    // The payment went through: the next sync brings the plan back.
    stripe.subscriptionStatus = "active";
    await proPlansNightly();
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "essentiel", planSource: "subscription" });
  });

  it("mails the launch offer's notices once per step, then downgrades the shops still on it", async () => {
    const owner = await member();
    const listingId = await published(owner);
    const proId = await shop(owner);
    vi.mocked(sendMail).mockClear();
    const endsAt = Date.now() + 20 * DAY_MS;
    offer.endsAt = new Date(endsAt).toISOString();

    // Sales still closed: the end date waits.
    flags.salesEnabled = false;
    expect((await proPlansNightly()).launchOffer).toEqual({ noticed: 0, ended: 0, failed: 0 });
    flags.salesEnabled = true;

    // No Resend headroom left: the notice waits for the next night, still due.
    mailRoom.value = 0;
    expect((await proPlansNightly()).launchOffer).toMatchObject({ noticed: 0, deferred: true });
    expect(mailsTo(owner)).toEqual([]);
    expect((await getProProfile(proId))?.launchOfferNoticeSentAt).toBeUndefined();
    mailRoom.value = null;

    await proPlansNightly();
    expect(mailsTo(owner)).toMatchObject([{ template: "launchOfferNotice", data: { kind: "ending", plan: "essentiel", shopName: "Atlas Auto", endsAt: offer.endsAt, freeListings: 0 } }]);
    expect((await getProProfile(proId))?.launchOfferNoticeSentAt).toBeInstanceOf(Date);
    await proPlansNightly();
    expect(mailsTo(owner)).toHaveLength(1);
    await proPlansNightly(new Date(endsAt - 6 * DAY_MS));
    expect(mailsTo(owner)).toHaveLength(2);

    // Past the end without mail budget: the shop keeps the offer until its last mail can go.
    mailRoom.value = 0;
    await proPlansNightly(new Date(endsAt + 30_000));
    expect((await getProProfile(proId))?.lifecycle).toBe("verified");
    mailRoom.value = null;

    await proPlansNightly(new Date(endsAt + 60_000));
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "downgraded", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none });
    expect(await getListing(listingId)).toMatchObject({ status: "paused", pausedReason: "quota" });
    expect(mailsTo(owner).at(-1)).toMatchObject({ template: "launchOfferNotice", data: { kind: "ended", paused: 1 } });
    await proPlansNightly(new Date(endsAt + 120_000));
    expect(mailsTo(owner)).toHaveLength(3);
  });
});

describe("billing reconciliation", () => {
  it("replays a Stripe event never delivered, once", async () => {
    const owner = await member();
    const proId = await shop(owner);
    await appUserOf(owner, proId, "essentiel");
    store.subscriptions = [rcSubscription({ entitlements: ["essentiel"] })];
    stripe.undelivered = [
      {
        id: `evt_${randomUUID().replace(/-/g, "")}`,
        object: "event",
        type: "checkout.session.completed",
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: "cs_test_1", object: "checkout.session", mode: "subscription", customer: `cus_${proId}`, subscription: "sub_Stripe1" } },
      },
    ];

    expect(await reconcileBilling()).toMatchObject({ stripeEvents: 1, failed: 0 });
    expect(stripe.calls.find((call) => call.path === "/v1/events")?.params).toMatchObject({ delivery_success: false, limit: 100 });
    expect(postStripeReceipt).toHaveBeenCalledWith(expect.any(String), "sub_Stripe1");
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "essentiel", planSource: "subscription" });
    expect(await reconcileBilling()).toMatchObject({ stripeEvents: 0, failed: 0 });
  });

  it("syncs a running Stripe subscription that has no plan here, and alerts one of an unknown customer", async () => {
    const owner = await member();
    const proId = await shop(owner);
    await appUserOf(owner, proId);
    store.subscriptions = [rcSubscription({ storeSubscriptionId: "sub_Stripe2" })];
    stripe.running = [
      { id: "sub_Stripe2", status: "active", customer: `cus_${proId}` },
      { id: "sub_Orphan", status: "past_due", customer: "cus_Unknown" },
      { id: "sub_Old", status: "incomplete_expired", customer: "cus_Unknown" },
      // Opened by another environment on the shared Stripe account, or reported on earlier nights.
      { id: "sub_Staging", status: "active", customer: "cus_Unknown", metadata: { env: "staging" } },
      { id: "sub_OldOrphan", status: "active", customer: "cus_Unknown", created: Math.floor(Date.now() / 1_000) - 10 * 86_400 },
    ];

    const run = await reconcileBilling();
    expect(run).toMatchObject({ subscriptions: 1, failed: 1 });
    expect(run.problems).toEqual([expect.stringContaining("sub_Orphan")]);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "active", plan: "business" });
    expect(await getSubscription(`pro_${proId}`)).toMatchObject({ status: "active", storeSubscriptionId: "sub_Stripe2" });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1" }));

    // Known and running here: nothing more to do.
    stripe.running = stripe.running.slice(0, 1);
    expect(await reconcileBilling()).toMatchObject({ subscriptions: 0, failed: 0 });
  });
});
