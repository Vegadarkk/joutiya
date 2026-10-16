// PhoneVerifier adapter (§2 "Adapters", §6 "Vérification WhatsApp"): inbound WhatsApp at the MVP
// (the user sends the code from their phone; Joutiya never sends), Twilio Verify later. Codes are
// hashed in valkey-queue for 10 minutes; the webhook matches sender number and code.

export interface VerificationChallenge {
  /** 6-digit code the user must send. */
  code: string;
  /** Joutiya's number, digits only (wa.me link target). */
  number: string;
  /** Prefilled click-to-chat link. */
  waLink: string;
  expiresAt: Date;
}

export type VerificationState = { status: "none" } | { status: "pending"; expiresAt: Date; phoneE164: string } | { status: "verified"; phoneE164: string } | { status: "expired" };

export interface PhoneVerifier {
  readonly name: string;
  /** Starts a challenge for `phoneE164` (already validated as a Moroccan mobile). */
  start(uid: string, phoneE164: string): Promise<VerificationChallenge>;
  status(uid: string): Promise<VerificationState>;
}
