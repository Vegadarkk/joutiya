import { serverEnv } from "@/lib/env";
import { readCapped } from "@/lib/http/body";
import { HttpError, unavailable } from "@/lib/http/errors";
import { apiRoute, json } from "@/lib/http/route";
import { logger } from "@/lib/logging/logger";
import { verifyStripeSignature } from "@/lib/payments/stripe-api";
import { receiveStripeEvent } from "@/lib/payments/stripe-events";

// Stripe → Pro subscriptions (phase 7 design §7). Signature first, on the raw body (400 otherwise,
// as Stripe expects); the event is recorded and queued, then 200. Any other answer makes Stripe
// retry (up to 3 days). Not gated by `salesEnabled`: a plan already paid is always honoured.
export const dynamic = "force-dynamic";

const MAX_BYTES = 256 * 1024;

export const POST = apiRoute(async (request) => {
  const secret = serverEnv().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw unavailable("Stripe webhook is not configured");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw new HttpError(413, "payload_too_large");
  const raw = await readCapped(request.body, MAX_BYTES);
  if (raw === null) throw new HttpError(413, "payload_too_large");
  if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"), secret)) {
    logger.warn({ webhook: "stripe" }, "webhook refused");
    throw new HttpError(400, "invalid_signature");
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Signed but not JSON: acknowledged as unreadable below.
  }
  const outcome = await receiveStripeEvent(body);
  logger.info({ webhook: "stripe", outcome }, "stripe event");
  return json({ received: true });
});
