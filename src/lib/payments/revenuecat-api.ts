import "server-only";
import { serverEnv } from "@/lib/env";
import { z } from "@/lib/zod";

// RevenueCat REST API v2, read side (phase 7 design §6, research/revenuecat.md §5): the worker
// re-reads a customer's one-time purchases before crediting or refunding a pack, so a webhook
// payload is never trusted on its own. Key: REVENUECAT_SECRET_API_KEY with
// `customer_information:purchases:read`; 480 requests a minute per key.

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
const pageSchema = z.object({ items: z.array(purchaseSchema), next_page: z.string().nullish() });

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

/** One-time purchases of `appUserId` in `environment`; empty for a customer RevenueCat does not know. */
export async function listCustomerPurchases(appUserId: string, environment: "sandbox" | "production", fetchImpl: typeof fetch = fetch): Promise<RevenueCatPurchase[]> {
  const env = serverEnv();
  if (!env.REVENUECAT_PROJECT_ID || !env.REVENUECAT_SECRET_API_KEY) throw new RevenueCatApiError(null, false, "RevenueCat API is not configured");
  const project = encodeURIComponent(env.REVENUECAT_PROJECT_ID);
  let url: URL | null = new URL(`/v2/projects/${project}/customers/${encodeURIComponent(appUserId)}/purchases?environment=${environment}&limit=100`, API_ORIGIN);
  const purchases: RevenueCatPurchase[] = [];
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new RevenueCatApiError(null, true, `RevenueCat API unreachable: ${(error as Error).name}`);
    }
    if (response.status === 404 && page === 0) return [];
    if (!response.ok) throw new RevenueCatApiError(response.status, [423, 429].includes(response.status) || response.status >= 500, `RevenueCat API answered ${response.status}`);
    const parsed = pageSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new RevenueCatApiError(response.status, false, "RevenueCat API answered an unexpected body");
    for (const item of parsed.data.items) {
      if (item.environment !== "sandbox" && item.environment !== "production") continue;
      purchases.push({ id: item.id, storePurchaseIdentifier: item.store_purchase_identifier ?? null, status: item.status, environment: item.environment, quantity: item.quantity ?? 1 });
    }
    // `next_page` is a path or a URL of the API: anything else is not followed (the key would leave).
    const next: URL | null = parsed.data.next_page ? new URL(parsed.data.next_page, API_ORIGIN) : null;
    url = next && next.origin === API_ORIGIN ? next : null;
  }
  return purchases;
}

/** The purchase of `transactionId` (store transaction id, or RevenueCat's own purchase id). */
export function findPurchase(purchases: readonly RevenueCatPurchase[], transactionId: string): RevenueCatPurchase | undefined {
  return purchases.find((purchase) => purchase.storePurchaseIdentifier === transactionId) ?? purchases.find((purchase) => purchase.id === transactionId);
}
