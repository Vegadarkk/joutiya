import "server-only";
import { getUser, getUserPrivate } from "@/lib/db/repositories/users";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { TemplateId } from "@/lib/mail/types";
import { displayPhone } from "@/lib/phone/normalize";

// Confirmation (or removal) e-mail of a phone verification, best effort: the verification itself
// is already recorded. `key` makes one mail per event: the WhatsApp message (wamid) for the
// inbound path, the moderator's check for a call during the KYBC review. A number that leaves the
// same account twice in a day, as when a phished transfer is undone and repeated, warns the holder
// each time.

export async function notifyPhoneChange(template: Extract<TemplateId, "phoneVerified" | "phoneRemoved">, uid: string, e164: string, key: string): Promise<void> {
  try {
    const [user, account] = await Promise.all([getUser(uid), getUserPrivate(uid)]);
    if (!user || !account?.email) return;
    await sendMail({
      template,
      locale: user.locale,
      to: account.email,
      data: { displayName: user.displayName, phone: displayPhone(e164) },
      priority: "security",
      idempotencyKey: `${template}:${uid}:${key}`,
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message, template }, "phone verification mail not sent");
  }
}
