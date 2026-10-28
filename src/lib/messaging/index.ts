import "server-only";
import { cidSchema, messageIdSchema } from "@/lib/contracts/messaging";
import { logger } from "@/lib/logging/logger";
import { publishConversationChange, publishEvents, publishMessageUpdate } from "./events";
import { STAFF_MESSAGES_MAX, hideMessageDoc, markAccountClosed, readTranscript, setConversationHoldDoc, unhideMessageDoc, type ConversationTranscript } from "./repository";

// What the other phase 5 lots use from messaging (design §4 L1 exports): moderation hides and
// restores a message (L2 strong signal, L3 decisions), the staff conversation view (D18), legal
// holds and freezes (L2 reports, L3 authority requests), the digest helpers (L5 job), and the
// live stream's revocation (L3 sanctions, D2). Ids are validated here: a cid or message id never
// becomes a Firestore path segment unchecked. Visible changes publish their live event (D2).

export { scheduleDigest, MESSAGING_KEYS, DIGEST_DELAY_MS, SEEN_TTL_SECONDS, UnreadUnavailableError } from "./unread";
export { readUnreadTotal, MESSAGING_QUOTAS } from "./service";
export { conversationId } from "./ids";
export { FREEZE_HOLD_PREFIXES, isFreezeHold, unreadSummary, type ConversationRecord, type ConversationTranscript, type MessageRecord, type UnreadSummaryItem } from "./repository";
export { setRepeatRiskReporter, type RepeatRiskReport } from "./system-report";
export { publishRevoked } from "./events";

const HOLD_ID = /^[^/\s]{1,64}$/;

function validRefs(cid: string, mid?: string): boolean {
  return cidSchema.safeParse(cid).success && (mid === undefined || messageIdSchema.safeParse(mid).success);
}

/**
 * Hides a message for moderation (D11 strong signal, D13 decision): text replaced by `⟦hidden⟧`,
 * original kept in conversations/{cid}/evidence/{mid}. `reason` is logged ("report:{id}",
 * "decision:{id}"...). False when the message does not exist or is already hidden.
 */
export async function hideMessage(cid: string, mid: string, reason: string): Promise<boolean> {
  if (!validRefs(cid, mid)) return false;
  const now = new Date();
  const participants = await hideMessageDoc(cid, mid, now);
  if (!participants) return false;
  logger.info({ cid, reason: reason.slice(0, 80) }, "messaging: message hidden");
  await publishMessageUpdate(cid, mid, participants, now);
  return true;
}

/** Restores a hidden message from its evidence (links masked again). False when not hidden. */
export async function unhideMessage(cid: string, mid: string): Promise<boolean> {
  if (!validRefs(cid, mid)) return false;
  const participants = await unhideMessageDoc(cid, mid);
  if (!participants) return false;
  logger.info({ cid }, "messaging: message restored");
  await publishMessageUpdate(cid, mid, participants, new Date());
  return true;
}

/**
 * Staff view of a conversation (D18): the conversation, its `limit` (<= 200) newest messages and
 * the evidence (original texts) of `evidenceFor`, by default of every masked or hidden message in
 * that window. Null when it does not exist. The caller checks the report or authority request,
 * the reason and writes the `conversation.read` audit entry.
 */
export async function getConversationForStaff(cid: string, limit: number = STAFF_MESSAGES_MAX, options: { evidenceFor?: readonly string[] } = {}): Promise<ConversationTranscript | null> {
  if (!validRefs(cid)) return null;
  const evidenceFor = options.evidenceFor?.filter((mid) => messageIdSchema.safeParse(mid).success);
  return readTranscript(cid, limit, evidenceFor);
}

/**
 * Freezes (`on`) or releases a conversation under a hold (D17: "authority:{id}"): frozen, nobody
 * can write; released, it reopens unless another freezing hold (authority:, dispute:, freeze:)
 * remains. False when the conversation does not exist or nothing changed.
 */
export async function freezeConversation(cid: string, holdId: string, on: boolean): Promise<boolean> {
  if (!validRefs(cid) || !HOLD_ID.test(holdId)) return false;
  const change = await setConversationHoldDoc(cid, holdId, on, { freeze: true });
  // Only a frozen or reopened conversation is visible to its participants: a hold alone says nothing.
  if (change?.statusChanged) await publishConversationChange(cid, change.participants, new Date());
  return change !== null;
}

/**
 * Adds or removes a legal hold ("report:{id}"...): the retention purge skips held conversations.
 * No live event: the participants see no change (and must not learn of a report).
 */
export async function setConversationHold(cid: string, holdId: string, on: boolean): Promise<boolean> {
  if (!validRefs(cid) || !HOLD_ID.test(holdId)) return false;
  return (await setConversationHoldDoc(cid, holdId, on)) !== null;
}

/**
 * Account closure (L7, D26): every conversation of `uid` becomes read-only for the other
 * participant (`accountClosed`), whose open tabs refetch the row (one live event each). Returns
 * how many conversations were marked.
 */
export async function closeAccountConversations(uid: string, now = new Date()): Promise<number> {
  const marked = await markAccountClosed(uid);
  const at = now.getTime();
  await publishEvents(marked.filter((item) => item.other !== uid).map((item) => ({ uid: item.other, event: { type: "conversation", cid: item.cid, at } })));
  return marked.length;
}
