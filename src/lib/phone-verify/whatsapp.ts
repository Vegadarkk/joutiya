import "server-only";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { codeHash, newCode } from "./codes";
import { whatsappDisplayNumber } from "./config";
import { CHALLENGE_TTL_SECONDS, challengeStore, type ChallengeStore } from "./store";
import type { PhoneVerifier, VerificationChallenge, VerificationState } from "./types";

// Inbound WhatsApp verifier (§6): the user sends "JOUTIYA <code>" to Joutiya's number from their
// own WhatsApp; Meta's signed webhook (src/app/api/webhooks/whatsapp) brings the sender number and
// the text back, and src/lib/phone-verify/inbound.ts matches them. Nothing is ever sent.

/** Click-to-chat link with the prefilled message (number: digits only, no "+"). */
export function waLink(number: string, code: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(`JOUTIYA ${code}`)}`;
}

export class WhatsAppInboundVerifier implements PhoneVerifier {
  readonly name = "whatsapp-inbound";

  constructor(
    private readonly store: () => ChallengeStore = challengeStore,
    private readonly number: () => string | undefined = whatsappDisplayNumber,
    private readonly now: () => number = Date.now,
  ) {}

  async start(uid: string, phoneE164: string): Promise<VerificationChallenge> {
    const number = this.number();
    if (!number) throw new Error("WhatsApp verification is not configured (WHATSAPP_DISPLAY_NUMBER)");
    const code = newCode();
    const expiresAt = this.now() + CHALLENGE_TTL_SECONDS * 1000;
    await this.store().put(uid, { phoneE164, codeHash: codeHash(uid, code), expiresAt });
    return { code, number, waLink: waLink(number, code), expiresAt: new Date(expiresAt) };
  }

  async status(uid: string): Promise<VerificationState> {
    const account = await getUserPrivate(uid);
    if (account?.phoneVerifiedAt && account.phoneE164) return { status: "verified", phoneE164: account.phoneE164 };
    const challenge = await this.store().getByUid(uid);
    if (!challenge) return { status: "none" };
    if (challenge.expiresAt <= this.now()) return { status: "expired" };
    return { status: "pending", expiresAt: new Date(challenge.expiresAt), phoneE164: challenge.phoneE164 };
  }
}
