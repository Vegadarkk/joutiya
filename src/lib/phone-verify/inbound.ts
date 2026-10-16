import "server-only";
import { audit } from "@/lib/audit";
import { getUser, getUserPrivate } from "@/lib/db/repositories/users";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { TemplateId } from "@/lib/mail/types";
import { captureServerException } from "@/lib/observability/capture";
import { displayPhone, MOROCCAN_MOBILE_E164 } from "@/lib/phone/normalize";
import { safeEqual } from "@/lib/security/hash";
import { claimVerifiedPhone } from "./accounts";
import { codeHash, phoneCodeKey, phoneKey } from "./codes";
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
        await notify("phoneRemoved", previousUid, e164);
      }
      await notify("phoneVerified", challenge.uid, e164);
    } catch (error) {
      summary.failed += 1;
      captureServerException(error, { route: "/api/webhooks/whatsapp", step: "processInbound" });
      // Let the retry of this message be processed: the verification may not have been recorded.
      await store.forget(item.wamid).catch(() => undefined);
    }
  }
  return summary;
}

/** Confirmation (or removal) e-mail, best effort: the verification itself is already recorded. */
async function notify(template: Extract<TemplateId, "phoneVerified" | "phoneRemoved">, uid: string, e164: string): Promise<void> {
  try {
    const [user, account] = await Promise.all([getUser(uid), getUserPrivate(uid)]);
    if (!user || !account?.email) return;
    await sendMail({
      template,
      locale: user.locale,
      to: account.email,
      data: { displayName: user.displayName, phone: displayPhone(e164) },
      priority: "security",
      idempotencyKey: `${template}:${uid}:${phoneKey(e164).slice(0, 16)}`,
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message, template }, "phone verification mail not sent");
  }
}
