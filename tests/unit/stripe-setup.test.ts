import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICING } from "@/config/pricing";
import { formEncode as appFormEncode, STRIPE_API_VERSION as APP_VERSION } from "@/lib/payments/stripe-api";
import { STRIPE_EVENT_TYPES } from "@/lib/payments/stripe-events";
import { desiredPrices, formEncode, keyProblem, parseCli, portalParams, priceMatches, runSetup, STRIPE_API_VERSION, WEBHOOK_EVENTS, type StripePrice } from "../../scripts/stripe-setup";

// scripts/stripe-setup.ts (phase 7 design §7): the Stripe objects of the Pro plans, created only in
// the recorded account with a restricted key of the environment's mode, found again on a second run,
// the webhook's signing secret written to a file and never printed.

const ACCOUNT = "acct_1UQxR07tCjk226ma";
const KEY = ["rk", "test", "setupkey"].join("_");
const SECRET = ["whsec", "setupsecret"].join("_");

afterEach(() => vi.unstubAllGlobals());

describe("stripe-setup plan", () => {
  it("parses the environment, --apply and --secret-file", () => {
    expect(parseCli(["staging"])).toEqual({ env: "staging", apply: false, secretFile: null });
    expect(parseCli(["prod", "--apply", "--secret-file", "/tmp/x"])).toEqual({ env: "prod", apply: true, secretFile: "/tmp/x" });
    for (const argv of [[], ["dev"], ["staging", "--secret-file"], ["staging", "--force"], ["staging", "prod"]]) expect(() => parseCli(argv)).toThrow(/usage/);
  });

  it("takes only a restricted key of the environment's mode", () => {
    expect(keyProblem("staging", KEY)).toBeNull();
    expect(keyProblem("staging", ["sk", "test", "x"].join("_"))).toMatch(/restricted rk_test_/);
    expect(keyProblem("prod", KEY)).toMatch(/rk_live_/);
  });

  it("matches the app: API version, form encoding and handled events", () => {
    expect(STRIPE_API_VERSION).toBe(APP_VERSION);
    const params = { a: { b: [1, { c: "d" }] }, e: true, f: undefined };
    expect(formEncode(params)).toBe(appFormEncode(params));
    expect([...WEBHOOK_EVENTS].sort()).toEqual([...STRIPE_EVENT_TYPES].sort());
  });

  it("prices each plan and interval in MAD, excluding tax, from the pricing defaults", () => {
    const prices = desiredPrices(DEFAULT_PRICING.plans);
    expect(prices.map((price) => [price.lookupKey, price.unitAmount])).toEqual([
      ["joutiya_essentiel_monthly_mad", 24_900],
      ["joutiya_essentiel_yearly_mad", 249_000],
      ["joutiya_business_monthly_mad", 59_000],
      ["joutiya_business_yearly_mad", 590_000],
    ]);
    const stripe: StripePrice = { id: "price_1", product: "joutiya_essentiel", currency: "mad", unit_amount: 24_900, lookup_key: "joutiya_essentiel_monthly_mad", recurring: { interval: "month", interval_count: 1 } };
    expect(priceMatches(stripe, prices[0]!)).toBe(true);
    expect(priceMatches({ ...stripe, unit_amount: 19_900 }, prices[0]!)).toBe(false);
    expect(priceMatches({ ...stripe, recurring: { interval: "year", interval_count: 1 } }, prices[0]!)).toBe(false);
  });

  it("lets the portal switch plans, upgrades invoiced at once and downgrades at period end", () => {
    const params = portalParams("prod", { joutiya_essentiel_monthly_mad: "price_em", joutiya_essentiel_yearly_mad: "price_ey", joutiya_business_monthly_mad: "price_bm", joutiya_business_yearly_mad: "price_by" });
    expect(params).toMatchObject({
      default_return_url: "https://joutiya.ma/fr/pro/abonnement",
      features: {
        customer_update: { enabled: false },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: {
          products: [
            { product: "joutiya_essentiel", prices: ["price_em", "price_ey"] },
            { product: "joutiya_business", prices: ["price_bm", "price_by"] },
          ],
          proration_behavior: "always_invoice",
          schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] },
        },
      },
    });
  });
});

describe("stripe-setup run", () => {
  function stubStripe(state: { account: string; existing: boolean }) {
    const posts: { path: string; body: string; idempotencyKey: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init: RequestInit) => {
        const path = input.pathname;
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (init.method === "POST") {
          posts.push({ path, body: String(init.body), idempotencyKey: new Headers(init.headers).get("idempotency-key") });
          if (path === "/v1/prices") return json(200, { id: `price_${posts.length}` });
          if (path === "/v1/billing_portal/configurations") return json(200, { id: "bpc_new" });
          if (path === "/v1/webhook_endpoints") return json(200, { id: "we_new", secret: SECRET });
          return json(200, { id: "joutiya_essentiel" });
        }
        if (path === "/v1/account") return json(200, { id: state.account });
        if (path.startsWith("/v1/products/")) return state.existing ? json(200, { id: path.split("/").pop() }) : json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
        if (path === "/v1/prices") {
          const data = state.existing ? desiredPrices(DEFAULT_PRICING.plans).map((price, index) => ({ id: `price_old${index}`, product: `joutiya_${price.plan}`, currency: "mad", unit_amount: price.unitAmount, lookup_key: price.lookupKey, recurring: { interval: price.interval === "monthly" ? "month" : "year", interval_count: 1 } })) : [];
          return json(200, { data });
        }
        if (path === "/v1/billing_portal/configurations") return json(200, { data: state.existing ? [{ id: "bpc_old", metadata: { joutiya: "pro-plans" } }] : [] });
        if (path === "/v1/webhook_endpoints") return json(200, { data: state.existing ? [{ id: "we_old", url: "https://staging.joutiya.ma/api/webhooks/stripe", enabled_events: [...WEBHOOK_EVENTS].reverse(), api_version: STRIPE_API_VERSION }] : [] });
        return json(404, { error: { code: "resource_missing" } });
      }),
    );
    return posts;
  }
  const base = { env: "staging" as const, key: KEY, accountId: ACCOUNT, plans: DEFAULT_PRICING.plans };

  it("creates everything once, writes the webhook secret to its file and never prints it", async () => {
    const posts = stubStripe({ account: ACCOUNT, existing: false });
    const lines: string[] = [];
    const secrets: [string, string][] = [];
    await runSetup({ ...base, apply: true, secretFile: "/tmp/joutiya-webhook.env", write: (line) => lines.push(line), writeSecret: (file, content) => secrets.push([file, content]) });
    expect(posts.map((post) => post.path)).toEqual(["/v1/products", "/v1/products", "/v1/prices", "/v1/prices", "/v1/prices", "/v1/prices", "/v1/billing_portal/configurations", "/v1/webhook_endpoints"]);
    expect(posts.filter((post) => post.path === "/v1/prices").every((post) => post.idempotencyKey?.startsWith("stripe-setup-staging-joutiya_"))).toBe(true);
    expect(new URLSearchParams(posts[2]!.body).get("tax_behavior")).toBe("exclusive");
    expect(new URLSearchParams(posts[7]!.body).get("api_version")).toBe(STRIPE_API_VERSION);
    expect(secrets).toEqual([["/tmp/joutiya-webhook.env", `STRIPE_WEBHOOK_SECRET=${SECRET}\n`]]);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).toContain('"stripePortalConfiguration": "bpc_new"');
  });

  it("changes nothing already right but the portal, and refuses another account or a new webhook without a secret file", async () => {
    const posts = stubStripe({ account: ACCOUNT, existing: true });
    await runSetup({ ...base, apply: true, secretFile: null, write: () => undefined });
    expect(posts.map((post) => post.path)).toEqual(["/v1/billing_portal/configurations/bpc_old"]);

    const dryRun = stubStripe({ account: ACCOUNT, existing: false });
    await runSetup({ ...base, apply: false, secretFile: null, write: () => undefined });
    expect(dryRun).toEqual([]);
    await expect(runSetup({ ...base, apply: true, secretFile: null, write: () => undefined })).rejects.toThrow(/--secret-file/);

    const other = stubStripe({ account: "acct_1OtherAccount00", existing: false });
    await expect(runSetup({ ...base, apply: true, secretFile: "/tmp/x", write: () => undefined })).rejects.toThrow(/another Stripe account/);
    expect(other).toEqual([]);
  });
});
