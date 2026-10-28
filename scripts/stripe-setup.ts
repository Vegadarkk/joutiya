// Creates the Stripe objects of the Pro plans (phase 7 design §7) in the Joutiya account recorded in
// infra/targets.json, and nowhere else: test mode for staging, live mode for prod. Dry run by
// default (reads, then prints what --apply would send); --apply sends. Each step finds its object
// again (product id, price lookup key, portal metadata, webhook URL), so a second run changes
// nothing that is already right.
//
//   node --env-file=<owner env file> scripts/stripe-setup.ts <staging|prod> [--apply] [--secret-file <new file>]
//
// Environment (never printed): JOUTIYA_STRIPE_SETUP_KEY, a short-lived restricted key (rk_test_ for
// staging, rk_live_ for prod) with write on Products, Prices, Customer portal and Webhook endpoints
// and read on the account, revoked after the run. Without it the dry run prints the plan offline.
//
// 1. the key's account must be targets.shared.stripe.accountId (GET /v1/account);
// 2. products joutiya_essentiel and joutiya_business;
// 3. one MAD price per plan and interval (lookup key joutiya_{plan}_{interval}_mad, amount excluding
//    tax from DEFAULT_PRICING): a changed amount gets a new price that takes the lookup key over;
// 4. the Customer Portal configuration: card, invoices, cancellation at period end, plan switch
//    between the four prices, upgrades invoiced at once and downgrades at period end (a plan's
//    monthly grant cannot be taken twice by switching back and forth);
// 5. the webhook endpoint {site}/api/webhooks/stripe with the events the handler reads, at the
//    app's API version. Its signing secret, returned once, goes to --secret-file (created, mode
//    600) as STRIPE_WEBHOOK_SECRET=..., never to the terminal.
// Then it prints the ids to set in config/pricing.plans. The VAT tax rate waits for the owner's
// tax decision (phase 7 tax cards): nothing is created for it here.

import { existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PaidPlanId, PlanInterval, PlansConfig } from "../src/config/pricing.ts";
import { validateTargets, type Targets } from "./assert-target.ts";
import { registerSrcResolver } from "./search-setup.ts";
import { requireEnvProxy } from "./env-proxy.ts";

export type SetupEnv = "staging" | "prod";
type StripeParam = string | number | boolean | null | undefined | readonly StripeParam[] | { readonly [key: string]: StripeParam };
export const KEY_VARIABLE = "JOUTIYA_STRIPE_SETUP_KEY";
export const SITES: Record<SetupEnv, string> = { staging: "https://staging.joutiya.ma", prod: "https://joutiya.ma" };
/** The events src/lib/payments/stripe-events.ts handles (STRIPE_EVENT_TYPES; a unit test keeps them equal). */
export const WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"];
export const PORTAL_TAG = "pro-plans";
const PLANS: readonly PaidPlanId[] = ["essentiel", "business"];
const INTERVALS: readonly PlanInterval[] = ["monthly", "yearly"];
const API = "https://api.stripe.com";
/** src/lib/payments/stripe-api.ts STRIPE_API_VERSION (that module cannot load in plain node; a unit test keeps them equal). */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export const PRODUCTS: Record<PaidPlanId, { id: string; name: string; description: string }> = {
  essentiel: { id: "joutiya_essentiel", name: "Joutiya Pro Essentiel", description: "Offre Pro Essentiel : annonces en ligne, crédits chaque mois, vitrine et badge Pro." },
  business: { id: "joutiya_business", name: "Joutiya Pro Business", description: "Offre Pro Business : annonces en ligne, crédits et « À la Une » chaque mois, vitrine et badge Pro." },
};

export interface DesiredPrice {
  plan: PaidPlanId;
  interval: PlanInterval;
  lookupKey: string;
  unitAmount: number;
}

export function desiredPrices(plans: Pick<PlansConfig, PaidPlanId>): DesiredPrice[] {
  return PLANS.flatMap((plan) => INTERVALS.map((interval) => ({ plan, interval, lookupKey: `joutiya_${plan}_${interval}_mad`, unitAmount: plans[plan].priceMinor[interval] })));
}

export interface StripePrice {
  id: string;
  product: string;
  currency: string;
  unit_amount: number | null;
  lookup_key: string | null;
  recurring: { interval: string; interval_count: number } | null;
}

export function priceMatches(price: StripePrice, wanted: DesiredPrice): boolean {
  return (
    price.product === PRODUCTS[wanted.plan].id &&
    price.currency === "mad" &&
    price.unit_amount === wanted.unitAmount &&
    price.recurring?.interval === (wanted.interval === "monthly" ? "month" : "year") &&
    price.recurring.interval_count === 1
  );
}

export function priceParams(wanted: DesiredPrice): Record<string, StripeParam> {
  return {
    product: PRODUCTS[wanted.plan].id,
    currency: "mad",
    unit_amount: wanted.unitAmount,
    recurring: { interval: wanted.interval === "monthly" ? "month" : "year", interval_count: 1 },
    tax_behavior: "exclusive",
    lookup_key: wanted.lookupKey,
    transfer_lookup_key: true,
    nickname: `${PRODUCTS[wanted.plan].name} (${wanted.interval === "monthly" ? "mensuel" : "annuel"})`,
  };
}

/** `prices`: lookup key -> price id, the four of desiredPrices. */
export function portalParams(env: SetupEnv, prices: Readonly<Record<string, string>>): Record<string, StripeParam> {
  const site = SITES[env];
  return {
    name: "Joutiya Pro",
    metadata: { joutiya: PORTAL_TAG },
    default_return_url: `${site}/fr/pro/abonnement`,
    business_profile: { headline: "Joutiya : l'abonnement de votre boutique", privacy_policy_url: `${site}/fr/legal/confidentialite`, terms_of_service_url: `${site}/fr/legal/cgv` },
    features: {
      // Name, address and tax ids come from the shop's verified identifiers, not from the portal.
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end", cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] } },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        products: PLANS.map((plan) => ({ product: PRODUCTS[plan].id, prices: INTERVALS.map((interval) => prices[`joutiya_${plan}_${interval}_mad`] ?? "") })),
        proration_behavior: "always_invoice",
        schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] },
      },
    },
  };
}

export function webhookUrl(env: SetupEnv): string {
  return `${SITES[env]}/api/webhooks/stripe`;
}

/** Problems with the setup key (never its value): restricted, of the environment's mode. */
export function keyProblem(env: SetupEnv, key: string): string | null {
  const wanted = env === "prod" ? "rk_live_" : "rk_test_";
  return key.startsWith(wanted) ? null : `${KEY_VARIABLE} must be a restricted ${wanted}… key for ${env}`;
}

export interface Cli {
  env: SetupEnv;
  apply: boolean;
  secretFile: string | null;
}

export function parseCli(argv: readonly string[]): Cli {
  const usage = "usage: scripts/stripe-setup.ts <staging|prod> [--apply] [--secret-file <new file>]";
  let env: SetupEnv | null = null;
  let apply = false;
  let secretFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--secret-file") {
      secretFile = argv[index + 1] ?? null;
      index += 1;
      if (!secretFile || secretFile.startsWith("--")) throw new Error(usage);
    } else if ((arg === "staging" || arg === "prod") && env === null) env = arg;
    else throw new Error(usage);
  }
  if (!env) throw new Error(usage);
  return { env, apply, secretFile };
}

interface StripeError {
  error?: { type?: string; code?: string; message?: string };
}

/** Stripe's form encoding, as formEncode of src/lib/payments/stripe-api.ts (`a[b][0]=c`). */
export function formEncode(params: Readonly<Record<string, StripeParam>>): string {
  const pairs: [string, string][] = [];
  const walk = (key: string, value: StripeParam): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item: StripeParam, index) => walk(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [name, item] of Object.entries(value as Record<string, StripeParam>)) walk(`${key}[${name}]`, item);
    else pairs.push([key, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return new URLSearchParams(pairs).toString();
}

function client(key: string) {
  return async <T>(method: "GET" | "POST", path: string, params: Readonly<Record<string, StripeParam>> = {}, idempotencyKey?: string): Promise<{ status: number; body: T & StripeError }> => {
    const url = new URL(path, API);
    const encoded = formEncode(params);
    if (method === "GET" && encoded) url.search = encoded;
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION, accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(url, { method, headers, ...(method === "POST" ? { body: encoded } : {}), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: (await response.json()) as T & StripeError };
  };
}

function failure(what: string, result: { status: number; body: StripeError }): Error {
  const { type, code, message } = result.body.error ?? {};
  return new Error(`${what}: HTTP ${result.status} ${[type, code].filter(Boolean).join("/")} ${message ?? ""}`.trim());
}

export interface SetupOptions extends Cli {
  /** The setup key; empty = offline plan. */
  key: string;
  accountId: string;
  plans: Pick<PlansConfig, PaidPlanId>;
  write?: (line: string) => void;
  writeSecret?: (file: string, content: string) => void;
  fileExists?: (file: string) => boolean;
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const { env, apply, secretFile, key, accountId } = options;
  const write = options.write ?? ((line: string) => console.log(line));
  const writeSecret = options.writeSecret ?? ((file: string, content: string) => writeFileSync(file, content, { flag: "wx", mode: 0o600 }));
  const desired = desiredPrices(options.plans);

  if (!key) {
    if (apply) throw new Error(`${KEY_VARIABLE} is not set`);
    write(`Offline plan for ${env} (${KEY_VARIABLE} not set, nothing read):`);
    for (const plan of PLANS) write(`  product ${PRODUCTS[plan].id}: ${PRODUCTS[plan].name}`);
    for (const price of desired) write(`  price ${price.lookupKey}: ${price.unitAmount / 100} MAD excl. tax per ${price.interval === "monthly" ? "month" : "year"}`);
    write(`  portal configuration "${PORTAL_TAG}": return ${portalParams(env, {}).default_return_url as string}`);
    write(`  webhook ${webhookUrl(env)}: ${WEBHOOK_EVENTS.join(", ")} (API ${STRIPE_API_VERSION})`);
    return;
  }
  const problem = keyProblem(env, key);
  if (problem) throw new Error(problem);
  const stripe = client(key);
  const run = async <T>(label: string, method: "POST", path: string, params: Record<string, StripeParam>, idempotencyKey?: string): Promise<T | null> => {
    write(`${apply ? "→" : "would"} ${label}`);
    if (!apply) return null;
    const result = await stripe<T>(method, path, params, idempotencyKey);
    if (result.status >= 300) throw failure(label, result);
    return result.body;
  };

  // 1. The account behind the key.
  const account = await stripe<{ id?: string }>("GET", "/v1/account");
  if (account.status !== 200) throw failure("GET /v1/account (the key needs read access to the account)", account);
  if (account.body.id !== accountId) throw new Error(`${KEY_VARIABLE} belongs to another Stripe account than shared.stripe.accountId: nothing done`);
  write(`Account ${accountId} (${env}, ${apply ? "apply" : "dry run"}).`);

  // Before any write: a new webhook endpoint shows its signing secret once, so its file must be new.
  const endpoints = await stripe<{ data?: { id: string; url: string; enabled_events: string[]; api_version: string | null }[] }>("GET", "/v1/webhook_endpoints", { limit: 100 });
  if (endpoints.status !== 200) throw failure("GET webhook endpoints", endpoints);
  const url = webhookUrl(env);
  const endpoint = endpoints.body.data?.find((item) => item.url === url);
  if (apply && !endpoint) {
    if (!secretFile) throw new Error("the webhook endpoint is new: pass --secret-file <new file> to receive its signing secret (nothing done)");
    if ((options.fileExists ?? existsSync)(secretFile)) throw new Error(`${secretFile} exists: the signing secret goes to a new file (nothing done)`);
  }

  // 2. Products.
  for (const plan of PLANS) {
    const { id, name, description } = PRODUCTS[plan];
    const found = await stripe<{ id?: string }>("GET", `/v1/products/${id}`);
    if (found.status === 200) write(`= product ${id}`);
    else if (found.status === 404) await run(`create product ${id}`, "POST", "/v1/products", { id, name, description, metadata: { joutiya: "pro-plan", plan } });
    else throw failure(`GET product ${id}`, found);
  }

  // 3. Prices (active ones carrying the lookup keys).
  const listed = await stripe<{ data?: StripePrice[] }>("GET", "/v1/prices", { lookup_keys: desired.map((price) => price.lookupKey), limit: 10 });
  if (listed.status !== 200) throw failure("GET prices", listed);
  const ids: Record<string, string> = {};
  for (const wanted of desired) {
    const current = listed.body.data?.find((price) => price.lookup_key === wanted.lookupKey);
    if (current && priceMatches(current, wanted)) {
      ids[wanted.lookupKey] = current.id;
      write(`= price ${wanted.lookupKey} ${current.id}`);
      continue;
    }
    const created = await run<{ id: string }>(`create price ${wanted.lookupKey} (${wanted.unitAmount / 100} MAD)${current ? `, replacing ${current.id}` : ""}`, "POST", "/v1/prices", priceParams(wanted), `stripe-setup-${env}-${wanted.lookupKey}-${wanted.unitAmount}`);
    if (created) ids[wanted.lookupKey] = created.id;
  }

  // 4. Customer Portal configuration (ours carries metadata.joutiya).
  const configurations = await stripe<{ data?: { id: string; metadata?: Record<string, string> }[] }>("GET", "/v1/billing_portal/configurations", { active: true, limit: 100 });
  if (configurations.status !== 200) throw failure("GET portal configurations", configurations);
  const ours = configurations.body.data?.find((configuration) => configuration.metadata?.joutiya === PORTAL_TAG);
  let portalId = ours?.id ?? null;
  if (apply && Object.keys(ids).length < desired.length) throw new Error("a price is missing: the portal configuration needs the four prices");
  if (ours) await run(`update portal configuration ${ours.id}`, "POST", `/v1/billing_portal/configurations/${ours.id}`, portalParams(env, ids));
  else portalId = (await run<{ id: string }>("create portal configuration", "POST", "/v1/billing_portal/configurations", portalParams(env, ids), `stripe-setup-${env}-portal`))?.id ?? null;

  // 5. Webhook endpoint (read before the writes).
  if (endpoint) {
    if (endpoint.api_version !== STRIPE_API_VERSION) console.warn(`! webhook ${endpoint.id} runs API ${endpoint.api_version ?? "account default"}, not ${STRIPE_API_VERSION}: it cannot be changed, recreate it by hand`);
    const same = [...endpoint.enabled_events].sort().join() === [...WEBHOOK_EVENTS].sort().join();
    if (same) write(`= webhook ${endpoint.id}`);
    else await run(`update webhook ${endpoint.id} events`, "POST", `/v1/webhook_endpoints/${endpoint.id}`, { enabled_events: WEBHOOK_EVENTS });
  } else {
    const created = await run<{ id: string; secret?: string }>(
      `create webhook ${url}`,
      "POST",
      "/v1/webhook_endpoints",
      { url, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_API_VERSION, description: `Joutiya ${env}: Pro subscriptions`, metadata: { joutiya: "pro-plans" } },
      `stripe-setup-${env}-webhook`,
    );
    if (created && secretFile) {
      if (!created.secret) throw new Error(`webhook ${created.id} created without a secret in the answer: roll it in the Dashboard`);
      writeSecret(secretFile, `STRIPE_WEBHOOK_SECRET=${created.secret}\n`);
      write(`  signing secret written to ${secretFile} (STRIPE_WEBHOOK_SECRET), not shown`);
    }
  }

  const stripePrices = (plan: PaidPlanId) => Object.fromEntries(INTERVALS.map((interval) => [interval, ids[`joutiya_${plan}_${interval}_mad`] ?? "<created by --apply>"]));
  write(`\nconfig/pricing.plans of ${env}:`);
  write(JSON.stringify({ essentiel: { stripePrices: stripePrices("essentiel") }, business: { stripePrices: stripePrices("business") }, stripePortalConfiguration: portalId ?? "<created by --apply>" }, null, 2));
  if (!apply) write("\nDry run: nothing sent. Add --apply to send.");
}

async function main(): Promise<void> {
  requireEnvProxy();
  const cli = parseCli(process.argv.slice(2));
  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const targetErrors = validateTargets(raw);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const accountId = (raw as Targets).shared.stripe.accountId;
  if (!accountId) throw new Error("shared.stripe.accountId must be recorded in infra/targets.json first");
  registerSrcResolver();
  const { DEFAULT_PRICING } = await import("../src/config/pricing.ts");
  await runSetup({ ...cli, key: process.env[KEY_VARIABLE] ?? "", accountId, plans: DEFAULT_PRICING.plans });
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]stripe-setup\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`stripe-setup: ${(error as Error).message}`);
    process.exit(1);
  });
}
