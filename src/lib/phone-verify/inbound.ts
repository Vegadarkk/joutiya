import "server-only";
import { audit } from "@/lib/audit";
import { getUser, getUserPrivate, setPhoneVerified } from "@/lib/db/repositories/users";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { captureServerException } from "@/lib/observability/capture";
import { displayPhone, MOROCCAN_MOBILE_E164 } from "@/lib/phone/normalize";
import { safeEqual } from "@/lib/security/hash";
import { isPhoneVerifiedByOther } from "./accounts";
import { codeHash, phoneKey } from "./codes";
import { challengeStore, type ChallengeStore } from "./store";
import type { InboundMessage } from "./webhook";

// Matches inbound WhatsApp messages against pending challenges (§6): sender number -> challenge,
// code -> hash, then the account is marked verified. Every message is processed at most once
// (wamid); a mismatch changes nothing, so the challenge stays pending until it expires.

export interface InboundSummary {
  received: number;
  /** Already processed (Meta retry). */
  duplicates: number;
  verified: number;
  /** No challenge, wrong or missing code, expired, foreign number, number taken meanwhile. */
  ignored: number;
  failed: number;
}

export interface ProcessOptions {
  store?: ChallengeStore;
  now?: number;
}

export async function processInbound(items: readonly InboundMessage[], options: ProcessOptions = {}): Promise<InboundSummary> {
  const store = options.store ?? challengeStore();
  const now = options.now ?? Date.now();
  const summary: InboundSummary = { received: items.length, duplicates: 0, verified: 0, ignored: 0, failed: 0 };
  for (const item of items) {
    try {
      if (await store.seen(item.wamid)) {
        summary.duplicates += 1;
        continue;
      }
      const e164 = `+${item.from}`;
      if (!item.code || !MOROCCAN_MOBILE_E164.test(e164)) {
        summary.ignored += 1;
        continue;
      }
      const challenge = await store.getByPhone(e164);
      if (!challenge || challenge.expiresAt <= now || !safeEqual(challenge.codeHash, codeHash(challenge.uid, item.code))) {
        summary.ignored += 1;
        continue;
      }
      if (await isPhoneVerifiedByOther(e164, challenge.uid)) {
        // Verified elsewhere since the challenge started: this one can never succeed.
        await store.delete(challenge.uid);
        summary.ignored += 1;
        continue;
      }
      await setPhoneVerified(challenge.uid, e164);
      await store.delete(challenge.uid);
      summary.verified += 1;
      await audit({ actorUid: challenge.uid, actorRole: "system", action: "phone.verified", target: { type: "user", id: challenge.uid }, automated: true });
      await notify(challenge.uid, e164);
    } catch (error) {
      summary.failed += 1;
      captureServerException(error, { route: "/api/webhooks/whatsapp", step: "processInbound" });
    }
  }
  return summary;
}

/** Confirmation e-mail, best effort: the verification itself is already recorded. */
async function notify(uid: string, e164: string): Promise<void> {
  try {
    const [user, account] = await Promise.all([getUser(uid), getUserPrivate(uid)]);
    if (!user || !account?.email) return;
    await sendMail({
      template: "phoneVerified",
      locale: user.locale,
      to: account.email,
      data: { displayName: user.displayName, phone: displayPhone(e164) },
      priority: "security",
      idempotencyKey: `phoneVerified:${uid}:${phoneKey(e164).slice(0, 16)}`,
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "phoneVerified mail not sent");
  }
}
