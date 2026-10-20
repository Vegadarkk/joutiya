import "server-only";
import { serverEnv } from "@/lib/env";

// Shared by the RevenueCat and Stripe event processors (phase 7 design §6, §7).

/** A step to retry later: RevenueCat does not show the purchase or the change yet, or an API is unavailable. */
export class BillingRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingRetryError";
  }
}

/** RevenueCat environment this deployment accepts: production events in prod only, sandbox elsewhere. */
export function expectedEnvironment(appEnv: string = serverEnv().APP_ENV): "SANDBOX" | "PRODUCTION" {
  return appEnv === "prod" ? "PRODUCTION" : "SANDBOX";
}
