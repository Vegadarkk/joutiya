import "server-only";
import { serverEnv } from "@/lib/env";

// WhatsApp inbound verification configuration (§9). Deployed environments need the real number
// (RECOMMENDED_DEPLOYED: a startup warning, then the feature answers 503); development falls back
// to a placeholder number, but the webhook credentials are always required: without them no
// inbound message could ever complete a challenge, so starting one would mislead the user.

/** Development placeholder, digits only (wa.me target); never a real subscriber. */
export const DEV_DISPLAY_NUMBER = "212600000000";

/** Joutiya's WhatsApp number in international format, digits only, or undefined when unset. */
export function whatsappDisplayNumber(): string | undefined {
  const env = serverEnv();
  if (env.WHATSAPP_DISPLAY_NUMBER) return env.WHATSAPP_DISPLAY_NUMBER.replace(/\D/g, "") || undefined;
  return env.APP_ENV === "dev" ? DEV_DISPLAY_NUMBER : undefined;
}

/** True when a challenge can be started and completed: display number, app secret and phone number id. */
export function isPhoneVerificationConfigured(): boolean {
  const env = serverEnv();
  return Boolean(whatsappDisplayNumber()) && Boolean(env.WHATSAPP_APP_SECRET) && Boolean(env.WHATSAPP_PHONE_NUMBER_ID);
}
