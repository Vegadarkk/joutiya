import { serverEnv } from "@/lib/env";
import { readCapped } from "@/lib/http/body";
import { HttpError, unauthenticated, unavailable } from "@/lib/http/errors";
import { apiRoute, json } from "@/lib/http/route";
import { logger } from "@/lib/logging/logger";
import { handleMailEvent, svixHeaders, verifySvix } from "@/lib/mail/webhook";

// Resend → Svix-signed events (§2 e-mail adapter): permanent bounces and complaints feed
// mailSuppressions. Signature first, raw body, 200 quickly: Resend retries anything else.
export const dynamic = "force-dynamic";

const MAX_BYTES = 256 * 1024;

export const POST = apiRoute(async (request) => {
  const secret = serverEnv().MAIL_WEBHOOK_SECRET;
  if (!secret) throw unavailable("MAIL_WEBHOOK_SECRET is not set");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw new HttpError(413, "payload_too_large");
  const raw = await readCapped(request.body, MAX_BYTES);
  if (raw === null) throw new HttpError(413, "payload_too_large");
  if (!verifySvix(raw, svixHeaders(request.headers), secret)) throw unauthenticated();

  try {
    const outcome = await handleMailEvent(raw);
    logger.info({ webhook: "resend", ...outcome }, "mail event");
  } catch (error) {
    // Already authenticated: a storage failure is ours to fix, not Resend's to retry forever.
    logger.error({ webhook: "resend", err: (error as Error).message }, "mail event failed");
  }
  return json({ received: true });
});
