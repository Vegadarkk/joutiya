import { serverEnv } from "@/lib/env";
import { readCapped } from "@/lib/http/body";
import { forbidden, HttpError, unavailable } from "@/lib/http/errors";
import { apiRoute, json } from "@/lib/http/route";
import { logger } from "@/lib/logging/logger";
import { processInbound } from "@/lib/phone-verify/inbound";
import { extractInbound, verifySignature } from "@/lib/phone-verify/webhook";
import { safeEqual } from "@/lib/security/hash";

// Meta WhatsApp Cloud API webhook (§6, §8; phase-2/research/services.md §4). GET: subscription
// handshake. POST: signature over the raw body, then each inbound text message is matched against
// the pending challenges. Always 200 once the signature is valid: Meta retries anything else for
// days and the dedupe on wamid absorbs its duplicates. Logs carry counts only, never numbers or texts.
export const dynamic = "force-dynamic";

/**
 * Meta batches can reach 3 MB; ours carry a handful of short texts. A cap below a batch would make
 * it a permanent 413 (Meta retries it for days), so the cap is generous: one HMAC over 1 MiB costs
 * nothing, and the signature is checked before anything is parsed.
 */
const MAX_BYTES = 1024 * 1024;

export const GET = apiRoute(async (request) => {
  const token = serverEnv().WHATSAPP_VERIFY_TOKEN;
  if (!token) throw unavailable("webhook verify token is not configured");
  const params = new URL(request.url).searchParams;
  const mode = params.get("hub.mode");
  const given = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || given === null || challenge === null || !safeEqual(given, token)) throw forbidden();
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
});

export const POST = apiRoute(async (request) => {
  const env = serverEnv();
  if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_PHONE_NUMBER_ID) throw unavailable("WhatsApp webhook is not configured");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw new HttpError(413, "payload_too_large");
  const raw = await readCapped(request.body, MAX_BYTES);
  if (raw === null) throw new HttpError(413, "payload_too_large");
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)) throw forbidden("invalid signature");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const summary = await processInbound(extractInbound(payload, env.WHATSAPP_PHONE_NUMBER_ID));
  if (summary.received > 0) logger.info({ whatsapp: summary }, "whatsapp webhook");
  return json({ received: true });
});
