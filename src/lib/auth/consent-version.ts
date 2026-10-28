import "server-only";
import { TRANSFERS_CONSENT_VERSION } from "@/lib/contracts/auth";
import type { ServerEnv } from "@/lib/env";
import { isPhoneVerificationConfigured } from "@/lib/phone-verify/config";

// The transfers consent names Meta (WhatsApp) only while phone verification is live (design D24).
// That text has its own version, so turning WhatsApp on asks every member again.

export const WHATSAPP_CONSENT_SUFFIX = "+wa";

/** The version sign-up records and the re-consent panel compares against, for this environment. */
export function transfersConsentVersion(env?: ServerEnv): string {
  return isPhoneVerificationConfigured(env) ? `${TRANSFERS_CONSENT_VERSION}${WHATSAPP_CONSENT_SUFFIX}` : TRANSFERS_CONSENT_VERSION;
}
