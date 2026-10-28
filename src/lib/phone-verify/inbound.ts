import "server-only";
import { audit } from "@/lib/audit";
import { captureServerException } from "@/lib/observability/capture";
import { MOROCCAN_MOBILE_E164 } from "@/lib/phone/normalize";
import { safeEqual } from "@/lib/security/hash";
import { claimVerifiedPhone } from "./accounts";
import { notifyPhoneChange } from "./notify";
import { codeHash, phoneCodeKey } from "./codes";
import { challengeStore, type ChallengeStore } from "./store";
import type { InboundMessage } from "./webhook";

// Matches inbound WhatsApp messages against pending challenges (§6): (sender number, code) ->
// challenge, code -> hash, then the account is marked verified. Proof of possession wins: a number
// verified on another account moves to the proving account, and the previous holder is told by
// e-mail. Every message is processed at most once (wamid), unless its processing failed: the mark
// is then dropped so Meta's retry is processed again. A mismatch changes nothing, so the challenge
// stays pending until it expires.

export interface InboundSummary {
  received: number;
  /** Already processed (Meta retry). */
  duplicates: number;
  verified: number;
  /** Of which the number was taken away from another account. */
  transferred: number;
  /** No challenge, wrong or missing code, expired, foreign number. */
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
  const summary: InboundSummary = { received: items.length, duplicates: 0, verified: 0, transferred: 0, ignored: 0, failed: 0 };
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
      // The code picks the challenge when several accounts started one for this number; the number
      // pointer (latest start) remains as a fallback.
      const challenge = (await store.getByCode(e164, phoneCodeKey(e164, item.code))) ?? (await store.getByPhone(e164));
      if (!challenge || challenge.expiresAt <= now || !safeEqual(challenge.codeHash, codeHash(challenge.uid, item.code))) {
        summary.ignored += 1;
        continue;
      }
      const { previousUid } = await claimVerifiedPhone(challenge.uid, e164);
      await store.delete(challenge.uid);
      summary.verified += 1;
      await audit({ actorUid: challenge.uid, actorRole: "system", action: "phone.verified", target: { type: "user", id: challenge.uid }, automated: true });
      if (previousUid) {
        summary.transferred += 1;
        await audit({ actorUid: challenge.uid, actorRole: "system", action: "phone.transferred", target: { type: "user", id: previousUid }, automated: true, reason: `number verified by ${challenge.uid}` });
        await notifyPhoneChange("phoneRemoved", previousUid, e164, item.wamid);
      }
      await notifyPhoneChange("phoneVerified", challenge.uid, e164, item.wamid);
    } catch (error) {
      summary.failed += 1;
      captureServerException(error, { route: "/api/webhooks/whatsapp", step: "processInbound" });
      // Let the retry of this message be processed: the verification may not have been recorded.
      await store.forget(item.wamid).catch(() => undefined);
    }
  }
  return summary;
}
