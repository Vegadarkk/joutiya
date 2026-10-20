import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICING, planOfEntitlement, resolvePricingConfig } from "@/config/pricing";
import { resetServerEnv } from "@/lib/env";
import { invoiceFields } from "@/lib/payments/plans";
import { listCustomerSubscriptions, postStripeReceipt, RevenueCatApiError, type RevenueCatSubscription } from "@/lib/payments/revenuecat-api";
import { formEncode, stripeRequest, StripeApiError, verifyStripeSignature } from "@/lib/payments/stripe-api";
import { addMonthsUtc, chooseSubscription, grantSlot, intervalOf, lifecycleEventFor, subscriptionStatusOf } from "@/lib/payments/subscriptions";
import type { ProLifecycleView } from "@/lib/pro/lifecycle";

// Pro subscriptions (phase 7 design §7): the plan grid, Stripe's form encoding and webhook
// signature, the monthly grant slots of a period, RevenueCat's subscription read and the status and
// lifecycle event each subscription calls for, and the shop identifiers printed on invoices.

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const at = (iso: string) => new Date(iso);

describe("plan grid", () => {
  it("sells Essentiel and Business, each carried by its own entitlement", () => {
    expect(DEFAULT_PRICING.plans.essentiel).toMatchObject({ priceMinor: { monthly: 24_900, yearly: 249_000 }, credits: 30, featured: 0 });
    expect(DEFAULT_PRICING.plans.business).toMatchObject({ priceMinor: { monthly: 59_000, yearly: 590_000 }, credits: 100, featured: 4 });
    expect(planOfEntitlement("business")).toBe("business");
    expect(planOfEntitlement("premium")).toBeUndefined();
  });

  it("refuses a shared entitlement and ids that are not Stripe's", () => {
    const { essentiel, business } = DEFAULT_PRICING.plans;
    expect(resolvePricingConfig({ plans: { essentiel, business: { ...business, entitlement: "essentiel" } } }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ plans: { essentiel: { ...essentiel, stripePrices: { monthly: "prod_1" } }, business } }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ plans: { essentiel, business, stripeTaxRate: "tax_1" } }).errors.length).toBeGreaterThan(0);
    const priced = resolvePricingConfig({ plans: { essentiel: { ...essentiel, stripePrices: { monthly: "price_1", yearly: "price_2" } }, business, stripeTaxRate: "txr_1" } });
    expect(priced.errors).toEqual([]);
    expect(priced.config.plans.essentiel.stripePrices).toEqual({ monthly: "price_1", yearly: "price_2" });
  });
});

describe("Stripe client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnv();
  });

  it("encodes nested objects and arrays in bracket notation and leaves out empty values", () => {
    const encoded = formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1, tax_rates: ["txr_1"] }], metadata: { a: "x y" }, skip: undefined, none: null, flag: false });
    expect(decodeURIComponent(encoded).split("&")).toEqual(["mode=subscription", "line_items[0][price]=price_1", "line_items[0][quantity]=1", "line_items[0][tax_rates][0]=txr_1", "metadata[a]=x+y", "flag=false"]);
  });

  it("sends the pinned version and the idempotency key, and marks 409, 429 and 5xx retryable", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_1");
    resetServerEnv();
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk_test_1");
      expect(headers.get("stripe-version")).toBe("2026-09-30.endive");
      expect(headers.get("idempotency-key")).toBe("key_1");
      expect(init?.body).toBe("name=Atlas");
      return reply(200, { id: "cus_1" });
    }) as unknown as typeof fetch;
    expect(await stripeRequest("POST", "/v1/customers", { name: "Atlas" }, { idempotencyKey: "key_1", fetchImpl })).toEqual({ id: "cus_1" });

    for (const [status, retryable] of [[409, true], [429, true], [503, true], [400, false], [401, false]] as const) {
      const failing = (async () => reply(status, { error: { code: "some_code", message: "secret detail" } })) as unknown as typeof fetch;
      const error = await stripeRequest("GET", "/v1/customers/cus_1", {}, { fetchImpl: failing }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StripeApiError);
      expect(error).toMatchObject({ status, retryable, code: "some_code" });
      expect((error as Error).message).not.toContain("secret detail");
    }
  });

  it("accepts a delivery signed with the secret within five minutes, nothing else", () => {
    const payload = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const sign = (secret: string, time = t) => createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex");
    const now = t * 1_000 + 60_000;
    expect(verifyStripeSignature(payload, `t=${t},v1=${sign("whsec_1")}`, "whsec_1", now)).toBe(true);
    // Several v1 signatures during a secret rotation: one match is enough.
    expect(verifyStripeSignature(payload, `t=${t},v1=${sign("whsec_old")},v1=${sign("whsec_1")}`, "whsec_1", now)).toBe(true);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sign("whsec_2")}`, "whsec_1", now)).toBe(false);
    expect(verifyStripeSignature(`${payload} `, `t=${t},v1=${sign("whsec_1")}`, "whsec_1", now)).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sign("whsec_1")}`, "whsec_1", t * 1_000 + 301_000)).toBe(false);
    expect(verifyStripeSignature(payload, `v1=${sign("whsec_1")}`, "whsec_1", now)).toBe(false);
    expect(verifyStripeSignature(payload, null, "whsec_1", now)).toBe(false);
  });
});

describe("grant slots", () => {
  it("adds calendar months in UTC, clamped to the month's last day", () => {
    expect(addMonthsUtc(at("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonthsUtc(at("2026-11-15T00:00:00Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });

  it("reads the interval from the period's length", () => {
    expect(intervalOf(at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z"))).toBe("monthly");
    expect(intervalOf(at("2026-10-01T00:00:00Z"), at("2027-10-01T00:00:00Z"))).toBe("yearly");
    expect(intervalOf(at("2026-10-01T00:00:00Z"), null)).toBe("monthly");
  });

  it("grants a monthly plan once per period and a yearly one once per month of it", () => {
    const start = at("2026-10-20T08:00:00Z");
    const monthEnd = at("2026-11-20T08:00:00Z");
    expect(grantSlot(start, monthEnd, "monthly", at("2026-11-10T00:00:00Z"))).toEqual({ start, end: monthEnd });

    const yearEnd = at("2027-10-20T08:00:00Z");
    expect(grantSlot(start, yearEnd, "yearly", at("2026-10-25T00:00:00Z"))).toEqual({ start, end: monthEnd });
    expect(grantSlot(start, yearEnd, "yearly", at("2027-03-21T00:00:00Z"))).toEqual({ start: at("2027-03-20T08:00:00Z"), end: at("2027-04-20T08:00:00Z") });
    // The last month never runs past the period.
    expect(grantSlot(start, at("2027-10-01T00:00:00Z"), "yearly", at("2027-09-25T00:00:00Z"))).toEqual({ start: at("2027-09-20T08:00:00Z"), end: at("2027-10-01T00:00:00Z") });
  });
});

const subscription = (extra: Partial<RevenueCatSubscription> = {}): RevenueCatSubscription => ({
  id: "sub_rc_1",
  status: "active",
  givesAccess: true,
  willRenew: true,
  periodStart: at("2026-10-01T00:00:00Z"),
  periodEnd: at("2026-11-01T00:00:00Z"),
  store: "stripe",
  storeSubscriptionId: "sub_1",
  environment: "sandbox",
  entitlements: ["essentiel"],
  ...extra,
});

describe("subscription status", () => {
  it("maps RevenueCat's status, access and renewal", () => {
    expect(subscriptionStatusOf(subscription())).toBe("active");
    expect(subscriptionStatusOf(subscription({ willRenew: false }))).toBe("cancelled");
    expect(subscriptionStatusOf(subscription({ status: "in_grace_period" }))).toBe("grace");
    expect(subscriptionStatusOf(subscription({ status: "in_billing_retry", givesAccess: false }))).toBe("billing_issue");
    expect(subscriptionStatusOf(subscription({ status: "expired", givesAccess: false }))).toBe("expired");
    expect(subscriptionStatusOf(subscription({ status: "paused", givesAccess: false }))).toBe("expired");
  });

  it("chooses the plan giving access, then the latest, Business over Essentiel", () => {
    const old = subscription({ id: "old", status: "expired", givesAccess: false, periodStart: at("2026-12-01T00:00:00Z"), entitlements: ["business"] });
    const live = subscription({ id: "live" });
    expect(chooseSubscription([old, live], DEFAULT_PRICING)).toMatchObject({ subscription: { id: "live" }, plan: "essentiel" });
    expect(chooseSubscription([subscription({ entitlements: ["essentiel", "business"] })], DEFAULT_PRICING)?.plan).toBe("business");
    expect(chooseSubscription([subscription({ entitlements: ["other"] })], DEFAULT_PRICING)).toBeNull();
    expect(chooseSubscription([], DEFAULT_PRICING)).toBeNull();
  });
});

describe("lifecycle event of a subscription", () => {
  const now = at("2026-10-20T00:00:00Z");
  const view = (extra: Partial<ProLifecycleView>): ProLifecycleView => ({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", ...extra });

  it("activates the plan from the launch offer, a downgrade or another plan, once", () => {
    expect(lifecycleEventFor(view({}), "active", "essentiel", now)).toEqual({ type: "subscription_active", plan: "essentiel" });
    expect(lifecycleEventFor(view({ lifecycle: "downgraded", plan: "none", planSource: "none" }), "cancelled", "business", now)).toEqual({ type: "subscription_active", plan: "business" });
    expect(lifecycleEventFor(view({ lifecycle: "active", planSource: "subscription" }), "active", "business", now)).toEqual({ type: "subscription_active", plan: "business" });
    expect(lifecycleEventFor(view({ lifecycle: "active", planSource: "subscription" }), "active", "essentiel", now)).toBeNull();
    // Payment recovered during the grace.
    expect(lifecycleEventFor(view({ lifecycle: "grace", planSource: "subscription", graceUntil: at("2026-10-25T00:00:00Z") }), "active", "essentiel", now)).toEqual({ type: "subscription_active", plan: "essentiel" });
  });

  it("opens the grace on a billing issue and ends it when it runs out", () => {
    const active = view({ lifecycle: "active", planSource: "subscription" });
    expect(lifecycleEventFor(active, "billing_issue", "essentiel", now)).toEqual({ type: "billing_issue" });
    expect(lifecycleEventFor(active, "grace", "essentiel", now)).toEqual({ type: "billing_issue" });
    expect(lifecycleEventFor(view({ lifecycle: "grace", planSource: "subscription", graceUntil: at("2026-10-25T00:00:00Z") }), "billing_issue", "essentiel", now)).toBeNull();
    expect(lifecycleEventFor(view({ lifecycle: "grace", planSource: "subscription", graceUntil: at("2026-10-19T00:00:00Z") }), "billing_issue", "essentiel", now)).toEqual({ type: "grace_ended" });
  });

  it("downgrades an expired subscription, never the launch offer, and leaves a suspended or unverified shop alone", () => {
    expect(lifecycleEventFor(view({ lifecycle: "active", planSource: "subscription" }), "expired", "essentiel", now)).toEqual({ type: "subscription_expired" });
    expect(lifecycleEventFor(view({ lifecycle: "verified" }), "expired", "essentiel", now)).toBeNull();
    expect(lifecycleEventFor(view({ lifecycle: "suspended", suspendedFrom: "active" }), "active", "essentiel", now)).toBeNull();
    expect(lifecycleEventFor(view({ lifecycle: "pending_verification", plan: "none", planSource: "none" }), "active", "essentiel", now)).toBeNull();
  });
});

describe("RevenueCat API v2 subscriptions and receipts", () => {
  beforeEach(() => {
    vi.stubEnv("REVENUECAT_PROJECT_ID", "proj1");
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "sk_test");
    vi.stubEnv("REVENUECAT_STRIPE_PUBLIC_KEY", "strp_test");
    resetServerEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnv();
  });

  it("reads the plan, period, renewal and entitlements of each subscription in the environment", async () => {
    const item = (id: string, environment: string, renewal: string) => ({
      object: "subscription",
      id,
      current_period_starts_at: Date.parse("2026-10-01T00:00:00Z"),
      current_period_ends_at: Date.parse("2026-11-01T00:00:00Z"),
      gives_access: true,
      auto_renewal_status: renewal,
      status: "active",
      store: "stripe",
      store_subscription_identifier: "sub_1",
      environment,
      entitlements: { items: [{ lookup_key: "business" }] },
    });
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toBe("https://api.revenuecat.com/v2/projects/proj1/customers/u1/subscriptions?environment=sandbox&limit=100");
      return reply(200, { items: [item("s1", "sandbox", "will_not_renew"), item("s2", "other", "will_renew")] });
    }) as unknown as typeof fetch;
    expect(await listCustomerSubscriptions("u1", "sandbox", fetchImpl)).toEqual([
      {
        id: "s1",
        status: "active",
        givesAccess: true,
        willRenew: false,
        periodStart: at("2026-10-01T00:00:00Z"),
        periodEnd: at("2026-11-01T00:00:00Z"),
        store: "stripe",
        storeSubscriptionId: "sub_1",
        environment: "sandbox",
        entitlements: ["business"],
      },
    ]);
  });

  it("posts a Stripe subscription with the Stripe app key, retrying only what may pass later", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.revenuecat.com/v1/receipts");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer strp_test");
      expect(headers.get("x-platform")).toBe("stripe");
      expect(JSON.parse(init?.body as string)).toEqual({ app_user_id: "u1", fetch_token: "sub_1" });
      return reply(200, {});
    }) as unknown as typeof fetch;
    await postStripeReceipt("u1", "sub_1", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const answering = (status: number) => (async () => reply(status, {})) as unknown as typeof fetch;
    await expect(postStripeReceipt("u1", "sub_1", answering(429))).rejects.toMatchObject({ retryable: true });
    await expect(postStripeReceipt("u1", "sub_1", answering(400))).rejects.toMatchObject({ retryable: false });
    vi.stubEnv("REVENUECAT_STRIPE_PUBLIC_KEY", "");
    resetServerEnv();
    await expect(postStripeReceipt("u1", "sub_1", fetchImpl)).rejects.toBeInstanceOf(RevenueCatApiError);
  });
});

describe("invoice identifiers", () => {
  it("prints the identifiers of each legal form", () => {
    expect(invoiceFields({ form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" })).toEqual([
      { name: "ICE", value: "001234567000089" },
      { name: "IF", value: "1234567" },
      { name: "RC", value: "12345" },
    ]);
    expect(invoiceFields({ form: "auto_entrepreneur", ice: "001234567000089", aeNumber: "998877" })).toEqual([
      { name: "ICE", value: "001234567000089" },
      { name: "N° auto-entrepreneur", value: "998877" },
    ]);
    expect(invoiceFields({ form: "commercant", ice: "001234567000089", tp: "55" })).toEqual([
      { name: "ICE", value: "001234567000089" },
      { name: "Taxe professionnelle", value: "55" },
    ]);
  });
});
