import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICING, packByProductId, resolvePricingConfig } from "@/config/pricing";
import { resetServerEnv } from "@/lib/env";
import { purchaseLink } from "@/lib/payments/packs";
import { findPurchase, listCustomerPurchases, productStoreIdentifier, RevenueCatApiError } from "@/lib/payments/revenuecat-api";
import { expectedEnvironment, revenueCatEnvelopeSchema } from "@/lib/payments/revenuecat-events";
import { onBillingJobFailed } from "@/worker/jobs/billing";

// Credit packs (phase 7 design §6): the pack grid of config/pricing, the Web Purchase Link, the
// tolerant reading of RevenueCat events, the environment each deployment accepts, the API v2
// purchases read, and the alert of a billing job's last attempt.

vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
const { alert } = await import("@/lib/alert");

describe("pack grid", () => {
  it("sells four MAD packs by default, the bigger ones with bonus credits", () => {
    expect(DEFAULT_PRICING.packs.map((pack) => [pack.id, pack.priceMinor, pack.paid, pack.bonus])).toEqual([
      ["mad_30", 3_000, 30, 0],
      ["mad_100", 10_000, 100, 10],
      ["mad_200", 20_000, 200, 30],
      ["mad_500", 50_000, 500, 100],
    ]);
    expect(packByProductId("joutiya_credits_200_mad")?.id).toBe("mad_200");
    expect(packByProductId("unknown")).toBeUndefined();
  });

  it("refuses duplicate ids or products and prices under RevenueCat's MAD minimum", () => {
    const pack = DEFAULT_PRICING.packs[0]!;
    expect(resolvePricingConfig({ packs: [pack, { ...pack, productId: "other" }] }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ packs: [pack, { ...pack, id: "other" }] }).errors.length).toBeGreaterThan(0);
    expect(resolvePricingConfig({ packs: [{ ...pack, priceMinor: 800 }] }).errors.length).toBeGreaterThan(0);
    const eur = { ...pack, id: "eur_10", currency: "EUR" as const, priceMinor: 1_000, productId: "joutiya_credits_10_eur", packageId: "credits_10_eur" };
    expect(resolvePricingConfig({ packs: [pack, eur] }).config.packs).toHaveLength(2);
  });
});

describe("purchase link", () => {
  it("appends the URL-encoded app user id, the currency and the package", () => {
    expect(purchaseLink("https://pay.rev.cat/tok/", "a b/c", { currency: "MAD", packageId: "credits_50_mad" })).toBe("https://pay.rev.cat/tok/a%20b%2Fc?currency=MAD&package_id=credits_50_mad&skip_purchase_success=true");
  });
});

describe("RevenueCat events", () => {
  const event = { id: "0f0e8f9e-1111-4c2d-9a3b-5d6e7f8a9b0c", type: "NON_RENEWING_PURCHASE", environment: "SANDBOX", app_user_id: "u" };

  it("reads a malformed optional field as absent, never the whole event", () => {
    const parsed = revenueCatEnvelopeSchema.parse({ api_version: "1.0", event: { ...event, currency: "dirham", price_in_purchased_currency: null, quantity: 0, unknown_field: true } });
    expect(parsed.event).toMatchObject({ id: event.id, type: "NON_RENEWING_PURCHASE" });
    expect(parsed.event.currency).toBeUndefined();
    expect(parsed.event.quantity).toBeUndefined();
  });

  it("refuses an event without its id, environment or customer", () => {
    expect(revenueCatEnvelopeSchema.safeParse({ event: { ...event, id: "../x" } }).success).toBe(false);
    expect(revenueCatEnvelopeSchema.safeParse({ event: { ...event, environment: "STAGING" } }).success).toBe(false);
    expect(revenueCatEnvelopeSchema.safeParse({ event: { ...event, app_user_id: "" } }).success).toBe(false);
  });

  it("accepts production events in prod only", () => {
    expect(expectedEnvironment("prod")).toBe("PRODUCTION");
    expect(expectedEnvironment("staging")).toBe("SANDBOX");
    expect(expectedEnvironment("dev")).toBe("SANDBOX");
  });
});

describe("RevenueCat API v2 purchases", () => {
  beforeEach(() => {
    vi.stubEnv("REVENUECAT_PROJECT_ID", "proj1");
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "sk_test");
    resetServerEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnv();
  });

  const item = (id: string, store: string | null, status = "owned") => ({ object: "purchase", id, store_purchase_identifier: store, status, environment: "sandbox", quantity: 1, product_id: "prod1" });
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads every page with the secret key and follows only the API's own next pages", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test");
      if (calls.length === 1) return reply(200, { items: [{ ...item("p1", "txn_1"), purchased_at: 1_790_000_000_000, store: "rc_billing", country: "MA" }], next_page: "/v2/projects/proj1/customers/a%20b/purchases?starting_after=p1" });
      return reply(200, { items: [item("p2", null, "refunded")], next_page: "https://evil.example/steal" });
    }) as unknown as typeof fetch;
    const purchases = await listCustomerPurchases("a b", "sandbox", fetchImpl);
    expect(calls).toEqual(["https://api.revenuecat.com/v2/projects/proj1/customers/a%20b/purchases?environment=sandbox&limit=100", "https://api.revenuecat.com/v2/projects/proj1/customers/a%20b/purchases?starting_after=p1"]);
    expect(purchases).toEqual([
      { id: "p1", storePurchaseIdentifier: "txn_1", status: "owned", environment: "sandbox", quantity: 1, productId: "prod1", purchasedAt: new Date(1_790_000_000_000), store: "rc_billing", country: "MA" },
      { id: "p2", storePurchaseIdentifier: null, status: "refunded", environment: "sandbox", quantity: 1, productId: "prod1" },
    ]);
    expect(findPurchase(purchases, "txn_1")?.id).toBe("p1");
    expect(findPurchase(purchases, "p2")?.status).toBe("refunded");
    expect(findPurchase(purchases, "txn_9")).toBeUndefined();
  });

  it("reads a product's store identifier, the one the webhooks and config/pricing use", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toBe("https://api.revenuecat.com/v2/projects/proj1/products/prod1");
      return reply(200, { object: "product", id: "prod1", store_identifier: "joutiya_credits_100_mad", type: "one_time" });
    }) as unknown as typeof fetch;
    expect(await productStoreIdentifier("prod1", fetchImpl)).toBe("joutiya_credits_100_mad");
    await expect(productStoreIdentifier("prod1", (async () => reply(403, {})) as unknown as typeof fetch)).rejects.toMatchObject({ retryable: false, status: 403 });
    await expect(productStoreIdentifier("prod1", (async () => reply(200, { id: "prod1" })) as unknown as typeof fetch)).rejects.toThrow(/unexpected body/);
  });

  it("answers no purchase for an unknown customer, a retryable error on 423, 429 or 5xx, a final one otherwise", async () => {
    expect(await listCustomerPurchases("x", "sandbox", (async () => reply(404, {})) as unknown as typeof fetch)).toEqual([]);
    await expect(listCustomerPurchases("x", "sandbox", (async () => reply(429, {})) as unknown as typeof fetch)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(listCustomerPurchases("x", "sandbox", (async () => reply(503, {})) as unknown as typeof fetch)).rejects.toMatchObject({ retryable: true });
    await expect(listCustomerPurchases("x", "sandbox", (async () => reply(423, {})) as unknown as typeof fetch)).rejects.toMatchObject({ retryable: true, status: 423 });
    await expect(listCustomerPurchases("x", "sandbox", (async () => reply(401, {})) as unknown as typeof fetch)).rejects.toMatchObject({ retryable: false, status: 401 });
    await expect(
      listCustomerPurchases("x", "sandbox", (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(RevenueCatApiError);
  });
});

describe("billing job failures", () => {
  it("alerts on the last attempt only", async () => {
    const job = { data: { eventId: "evt_1" }, attemptsMade: 3, opts: { attempts: 8 } };
    expect(await onBillingJobFailed(job, new Error("purchase not visible"))).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    expect(await onBillingJobFailed({ ...job, attemptsMade: 8 }, new Error("purchase not visible"))).toBe(true);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toMatchObject({ severity: "P1", title: "Paiement RevenueCat non traité (evt_1)" });
  });
});
