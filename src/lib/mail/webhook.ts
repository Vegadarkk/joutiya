import { createHmac } from "node:crypto";
import type { QuotaId } from "@/config/quotas";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { safeEqual } from "@/lib/security/hash";
import { addSuppression as storeSuppression } from "./suppressions";

// Resend webhooks are signed by Svix (research/services.md §2.3): HMAC-SHA256 of
// `${svix-id}.${svix-timestamp}.${rawBody}` under the base64-decoded secret (after "whsec_"),
// compared constant-time against every "v1,<base64>" entry of svix-signature.

export const SVIX_TOLERANCE_SECONDS = 300;

export interface SvixHeaders {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
}

export function svixHeaders(headers: Headers): SvixHeaders {
  return { id: headers.get("svix-id"), timestamp: headers.get("svix-timestamp"), signature: headers.get("svix-signature") };
}

/** Pure signature check; `now` in milliseconds. False on any missing or malformed input. */
export function verifySvix(raw: string, headers: SvixHeaders, secret: string, now = Date.now(), toleranceSeconds = SVIX_TOLERANCE_SECONDS): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > toleranceSeconds) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return signature
    .split(/\s+/)
    .filter((entry) => entry.startsWith("v1,"))
    .some((entry) => safeEqual(entry.slice(3), expected));
}

const recipient = z.string().trim().min(3).max(320).includes("@");
const eventSchema = z.looseObject({
  type: z.string().max(64),
  data: z
    .looseObject({
      to: z.union([z.array(recipient).max(50), recipient]).optional(),
      bounce: z.looseObject({ type: z.string().max(32).optional() }).optional(),
    })
    .optional(),
});

export type MailEventOutcome = { handled: "bounce" | "complaint"; recipients: number } | { handled: "ignored"; reason: string };

export type MailEventReason = "bounce" | "complaint";

export interface SuppressionStore {
  addSuppression(email: string, reason: MailEventReason, provider: string): Promise<void>;
  /** Counts the day's delivery incidents, one per recipient (quota guards: 70 % and 100 % alerts). */
  countEvent(reason: MailEventReason, recipients: number): Promise<void>;
}

/** Day counters of the bounce and complaint rates (§2 "taux de rebond"): src/config/quotas.ts. */
const EVENT_QUOTA = { bounce: "resend.bounces", complaint: "resend.complaints" } as const satisfies Record<MailEventReason, QuotaId>;

async function countMailEvent(reason: MailEventReason, recipients: number): Promise<void> {
  if (recipients > 0) await consume(EVENT_QUOTA[reason], recipients);
}

const defaultStore: SuppressionStore = { addSuppression: storeSuppression, countEvent: countMailEvent };

/**
 * Applies one Resend event: permanent bounces and complaints are counted (quota alerts) and
 * suppress each recipient; soft bounces (Transient, Temporary, Undetermined) and every other event
 * are ignored.
 */
export async function handleMailEvent(raw: string, store: SuppressionStore = defaultStore): Promise<MailEventOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { handled: "ignored", reason: "invalid_json" };
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return { handled: "ignored", reason: "invalid_event" };
  const { type, data } = parsed.data;
  const recipients = data?.to === undefined ? [] : Array.isArray(data.to) ? data.to : [data.to];

  let reason: MailEventReason;
  if (type === "email.bounced") {
    if (data?.bounce?.type?.toLowerCase() !== "permanent") return { handled: "ignored", reason: "soft_bounce" };
    reason = "bounce";
  } else if (type === "email.complained") {
    reason = "complaint";
  } else {
    return { handled: "ignored", reason: type };
  }
  // Counted first: a failing suppression write (logged by the route) must not hide the incident.
  await store.countEvent(reason, recipients.length);
  for (const email of recipients) await store.addSuppression(email, reason, "resend");
  return { handled: reason, recipients: recipients.length };
}
