import "server-only";
import { serverEnv } from "@/lib/env";
import { z } from "@/lib/zod";

// RevenueCat REST API (phase 7 design §6, §7, research/revenuecat.md §5): the worker re-reads a
// customer's one-time purchases before crediting or refunding a pack, and its subscriptions before
// changing a Pro's plan, so a webhook payload is never trusted on its own. Key:
// REVENUECAT_SECRET_API_KEY with `customer_information:purchases:read` and
// `customer_information:subscriptions:read`; 480 requests a minute per key. Stripe subscriptions
// reach RevenueCat by POST /v1/receipts with the public key of its Stripe app.

const API_ORIGIN = "https://api.revenuecat.com";
const TIMEOUT_MS = 10_000;
/** A customer's packs fit in a few pages of 100; past this the list is cut (logged by the caller). */
const MAX_PAGES = 10;

const purchaseSchema = z.object({
  id: z.string().min(1).max(255),
  store_purchase_identifier: z.string().min(1).max(255).nullish(),
  status: z.string().min(1).max(32),
  environment: z.string().min(1).max(32),
  quantity: z.number().int().nullish(),
});

export interface RevenueCatPurchase {
  id: string;
  /** The store's transaction id: the webhook's `transaction_id`. */
  storePurchaseIdentifier: string | null;
  /** `owned` or `refunded`. */
  status: string;
  environment: "sandbox" | "production";
  quantity: number;
}

/** A failed call; `retryable` when a later attempt may succeed (rate limit, 5xx, network). */
export class RevenueCatApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "RevenueCatApiError";
  }
}

export function isRevenueCatApiConfigured(env: { REVENUECAT_PROJECT_ID?: string; REVENUECAT_SECRET_API_KEY?: string } = serverEnv()): boolean {
  return Boolean(env.REVENUECAT_PROJECT_ID && env.REVENUECAT_SECRET_API_KEY);
}

/** Reads every page of a customer list (`purchases`, `subscriptions`) in `environment`; empty for a customer RevenueCat does not know. */
async function listCustomerItems<T>(appUserId: string, list: string, environment: "sandbox" | "production", item: z.ZodType<T>, fetchImpl: typeof fetch): Promise<T[]> {
  const env = serverEnv();
  if (!env.REVENUECAT_PROJECT_ID || !env.REVENUECAT_SECRET_API_KEY) throw new RevenueCatApiError(null, false, "RevenueCat API is not configured");
  const project = encodeURIComponent(env.REVENUECAT_PROJECT_ID);
  const pageSchema = z.object({ items: z.array(item), next_page: z.string().nullish() });
  let url: URL | null = new URL(`/v2/projects/${project}/customers/${encodeURIComponent(appUserId)}/${list}?environment=${environment}&limit=100`, API_ORIGIN);
  const items: T[] = [];
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new RevenueCatApiError(null, true, `RevenueCat API unreachable: ${(error as Error).name}`);
    }
    if (response.status === 404 && page === 0) return [];
    // 423: the customer is locked by another request for a moment.
    if (!response.ok) throw new RevenueCatApiError(response.status, [423, 429].includes(response.status) || response.status >= 500, `RevenueCat API answered ${response.status}`);
    const parsed = pageSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new RevenueCatApiError(response.status, false, "RevenueCat API answered an unexpected body");
    items.push(...parsed.data.items);
    // `next_page` is a path or a URL of the API: anything else is not followed (the key would leave).
    const next: URL | null = parsed.data.next_page ? new URL(parsed.data.next_page, API_ORIGIN) : null;
    url = next && next.origin === API_ORIGIN ? next : null;
  }
  return items;
}

const isEnvironment = (value: string): value is "sandbox" | "production" => value === "sandbox" || value === "production";

/** One-time purchases of `appUserId` in `environment`; empty for a customer RevenueCat does not know. */
export async function listCustomerPurchases(appUserId: string, environment: "sandbox" | "production", fetchImpl: typeof fetch = fetch): Promise<RevenueCatPurchase[]> {
  const items = await listCustomerItems(appUserId, "purchases", environment, purchaseSchema, fetchImpl);
  return items.flatMap((item) =>
    isEnvironment(item.environment) ? [{ id: item.id, storePurchaseIdentifier: item.store_purchase_identifier ?? null, status: item.status, environment: item.environment, quantity: item.quantity ?? 1 }] : [],
  );
}

const subscriptionSchema = z.object({
  id: z.string().min(1).max(255),
  current_period_starts_at: z.number().int().positive(),
  current_period_ends_at: z.number().int().positive().nullish(),
  gives_access: z.boolean(),
  auto_renewal_status: z.string().min(1).max(64),
  status: z.string().min(1).max(32),
  store: z.string().min(1).max(32),
  store_subscription_identifier: z.string().min(1).max(255),
  environment: z.string().min(1).max(32),
  entitlements: z.object({ items: z.array(z.object({ lookup_key: z.string().min(1).max(200) })) }).nullish(),
});

export interface RevenueCatSubscription {
  id: string;
  /** `active`, `trialing`, `in_grace_period`, `in_billing_retry`, `expired`, `paused`, `incomplete`, `unknown`. */
  status: string;
  givesAccess: boolean;
  willRenew: boolean;
  periodStart: Date;
  periodEnd: Date | null;
  store: string;
  /** The store's id (`sub_...` for Stripe). */
  storeSubscriptionId: string;
  environment: "sandbox" | "production";
  /** Entitlement lookup keys (the plan, config/pricing.plans). */
  entitlements: string[];
}

/** Subscriptions of `appUserId` in `environment` (key permission `customer_information:subscriptions:read`). */
export async function listCustomerSubscriptions(appUserId: string, environment: "sandbox" | "production", fetchImpl: typeof fetch = fetch): Promise<RevenueCatSubscription[]> {
  const items = await listCustomerItems(appUserId, "subscriptions", environment, subscriptionSchema, fetchImpl);
  return items.flatMap((item) =>
    isEnvironment(item.environment)
      ? [
          {
            id: item.id,
            status: item.status,
            givesAccess: item.gives_access,
            willRenew: item.auto_renewal_status === "will_renew" || item.auto_renewal_status === "has_already_renewed" || item.auto_renewal_status === "will_change_product",
            periodStart: new Date(item.current_period_starts_at),
            periodEnd: item.current_period_ends_at ? new Date(item.current_period_ends_at) : null,
            store: item.store,
            storeSubscriptionId: item.store_subscription_identifier,
            environment: item.environment,
            entitlements: item.entitlements?.items.map((entitlement) => entitlement.lookup_key) ?? [],
          },
        ]
      : [],
  );
}

/**
 * Hands a Stripe subscription to RevenueCat (POST /v1/receipts, `X-Platform: stripe`) so it tracks
 * it at once instead of on its next refresh; posting it again after a change refreshes it.
 */
export async function postStripeReceipt(appUserId: string, stripeSubscriptionId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const key = serverEnv().REVENUECAT_STRIPE_PUBLIC_KEY;
  if (!key) throw new RevenueCatApiError(null, false, "REVENUECAT_STRIPE_PUBLIC_KEY is not set");
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/receipts", API_ORIGIN), {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-platform": "stripe", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ app_user_id: appUserId, fetch_token: stripeSubscriptionId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new RevenueCatApiError(null, true, `RevenueCat API unreachable: ${(error as Error).name}`);
  }
  if (!response.ok) throw new RevenueCatApiError(response.status, [423, 429].includes(response.status) || response.status >= 500, `RevenueCat receipts answered ${response.status}`);
}

/** The purchase of `transactionId` (store transaction id, or RevenueCat's own purchase id). */
export function findPurchase(purchases: readonly RevenueCatPurchase[], transactionId: string): RevenueCatPurchase | undefined {
  return purchases.find((purchase) => purchase.storePurchaseIdentifier === transactionId) ?? purchases.find((purchase) => purchase.id === transactionId);
}
