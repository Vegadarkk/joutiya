import { serverEnv } from "@/lib/env";
import { readCapped } from "@/lib/http/body";
import { HttpError, unauthenticated, unavailable } from "@/lib/http/errors";
import { apiRoute, json } from "@/lib/http/route";
import { logger } from "@/lib/logging/logger";
import { receiveRevenueCatEvent } from "@/lib/payments/revenuecat-events";
import { authenticateWebhook, SIGNATURE_HEADER } from "@/lib/payments/revenuecat-webhook";

// RevenueCat → credit pack purchases and refunds (phase 7 design §6). Authorization value and HMAC
// signature first, on the raw body; the event is recorded and queued, then 200. Any other answer
// makes RevenueCat retry (5 times over about 80 minutes), which an infrastructure error wants.
// Not gated by `salesEnabled`: a pack already paid is always credited.
export const dynamic = "force-dynamic";

const MAX_BYTES = 64 * 1024;

export const POST = apiRoute(async (request) => {
  const env = serverEnv();
  if (!env.REVENUECAT_WEBHOOK_AUTH || !env.REVENUECAT_WEBHOOK_HMAC_SECRET) throw unavailable("RevenueCat webhook is not configured");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw new HttpError(413, "payload_too_large");
  const raw = await readCapped(request.body, MAX_BYTES);
  if (raw === null) throw new HttpError(413, "payload_too_large");
  const failure = authenticateWebhook({
    rawBody: raw,
    authorization: request.headers.get("authorization"),
    signature: request.headers.get(SIGNATURE_HEADER),
    expectedAuthorization: env.REVENUECAT_WEBHOOK_AUTH,
    signingSecret: env.REVENUECAT_WEBHOOK_HMAC_SECRET,
    now: new Date(),
  });
  if (failure) {
    logger.warn({ webhook: "revenuecat", failure }, "webhook refused");
    throw unauthenticated();
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Authenticated but not JSON: acknowledged as unreadable below.
  }
  const outcome = await receiveRevenueCatEvent(body);
  logger.info({ webhook: "revenuecat", outcome }, "revenuecat event");
  return json({ received: true });
});
