import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/security/hash";

// Pure helpers of the Meta webhook (phase-2/research/services.md §4): signature over the raw body
// bytes, then extraction of the inbound text messages addressed to our phone number id. Status
// updates (`value.statuses`) and other message types are ignored. Message bodies never reach logs.

export interface InboundMessage {
  /** Meta message id: dedupe key of the retries. */
  wamid: string;
  /** Sender in international format, digits only (no "+"). */
  from: string;
  /** First 6-digit group of the text, or null. */
  code: string | null;
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const CODE = /\b(\d{6})\b/;

/** `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256 of the raw body under the app secret. */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = SIGNATURE.exec(header.trim());
  if (!match?.[1]) return false;
  const expected = createHmac("sha256", appSecret).update(Buffer.from(rawBody, "utf8")).digest("hex");
  return safeEqual(expected, match[1].toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inbound text messages of a webhook payload addressed to `phoneNumberId`, in order. */
export function extractInbound(payload: unknown, phoneNumberId: string): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (!phoneNumberId || !isRecord(payload) || payload["object"] !== "whatsapp_business_account" || !Array.isArray(payload["entry"])) return out;
  for (const entry of payload["entry"]) {
    if (!isRecord(entry) || !Array.isArray(entry["changes"])) continue;
    for (const change of entry["changes"]) {
      if (!isRecord(change) || !isRecord(change["value"])) continue;
      const value = change["value"];
      const metadata = isRecord(value["metadata"]) ? value["metadata"] : {};
      if (metadata["phone_number_id"] !== phoneNumberId) continue;
      if (!Array.isArray(value["messages"])) continue;
      for (const message of value["messages"]) {
        if (!isRecord(message) || message["type"] !== "text") continue;
        const wamid = typeof message["id"] === "string" ? message["id"].trim() : "";
        const from = typeof message["from"] === "string" ? message["from"].replace(/\D/g, "") : "";
        if (!wamid || !from) continue;
        const text = isRecord(message["text"]) && typeof message["text"]["body"] === "string" ? message["text"]["body"] : "";
        out.push({ wamid, from, code: CODE.exec(text)?.[1] ?? null });
      }
    }
  }
  return out;
}
