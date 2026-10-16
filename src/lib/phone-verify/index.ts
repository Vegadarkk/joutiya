import "server-only";
import type { PhoneVerifier } from "./types";
import { WhatsAppInboundVerifier } from "./whatsapp";

// PhoneVerifier adapter entry point (§2 "Adapters"): inbound WhatsApp at the MVP; Twilio Verify
// would be another implementation chosen here by configuration.

export { isPhoneVerificationConfigured, whatsappDisplayNumber } from "./config";
export type { PhoneVerifier, VerificationChallenge, VerificationState } from "./types";

let instance: PhoneVerifier | undefined;

export function phoneVerifier(): PhoneVerifier {
  instance ??= new WhatsAppInboundVerifier();
  return instance;
}

/** Tests only. */
export function resetPhoneVerifierForTests(): void {
  instance = undefined;
}
