import "server-only";
import { COLLECTIONS, mailSuppressionSchema, type MailSuppressionDoc } from "@/lib/db/schemas";
import { emailNormHash } from "@/lib/db/repositories/users";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";

// mailSuppressions/{emailNormHash} (§5): addresses that bounced permanently or complained. Only
// non-security mails honour the list; the key is the peppered hash, the address itself is never stored.

const ref = (email: string) => db().collection(COLLECTIONS.mailSuppressions).doc(emailNormHash(email));

/** True when the address must not receive transactional mail. A failing lookup never blocks a send. */
export async function isSuppressed(email: string): Promise<boolean> {
  if (!isFirebaseConfigured()) return false;
  try {
    return (await ref(email).get()).exists;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "mail suppression lookup failed");
    return false;
  }
}

export async function addSuppression(email: string, reason: MailSuppressionDoc["reason"], provider: string, at = new Date()): Promise<void> {
  if (!isFirebaseConfigured()) {
    logger.warn({ reason, provider }, "mail suppression not stored (Firebase not configured)");
    return;
  }
  const doc = mailSuppressionSchema.parse({ reason, provider: provider.slice(0, 20), at });
  await ref(email).set(doc, { merge: true });
  logger.info({ reason, provider }, "mail suppression added");
}

export async function removeSuppression(email: string): Promise<void> {
  if (!isFirebaseConfigured()) return;
  await ref(email).delete();
}
