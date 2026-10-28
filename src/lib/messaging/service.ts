import "server-only";
import { subcategoryById } from "@/config/categories";
import type { QuotaId } from "@/config/quotas";
import { MESSAGE_TEXT_MAX, type MessageRiskFlag, type SendMessageResponse, type StartConversationResponse } from "@/lib/contracts/messaging";
import { getListing } from "@/lib/db/repositories/listings";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import type { ConversationDoc, UserDoc } from "@/lib/db/schemas";
import type { Claims } from "@/lib/firebase/claims";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { PUBLIC_STATES } from "@/lib/listings/public";
import { logger } from "@/lib/logging/logger";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { publishConversationChange, publishNewMessage, publishRead } from "./events";
import { conversationId } from "./ids";
import {
  BlockListFullError,
  ConversationAccessError,
  ConversationExistsError,
  appendMessage,
  conversationPurgeAt,
  counterpartOf,
  createConversation,
  getConversation,
  getParticipantConversation,
  getUserBlocks,
  isPairBlocked,
  lastMessageOf,
  markConversationRead,
  setPairBlockedBy,
  setParticipantState,
  setUserBlock,
  unreadCounts,
  type ConversationExtension,
  type ConversationRecord,
  type NewMessageInput,
} from "./repository";
import { analyzeMessage, type MessageAnalysis } from "./risk";
import { fileRepeatRiskReport } from "./system-report";
import { UnreadUnavailableError, clearUnread, markSeen, recordRiskyMessage, recordUnread, scheduleDigest, unreadTotal } from "./unread";

// Messaging rules (design D4-D9, D21): who may write to whom, the risk flags and masking of every
// message, the per-participant state, and what follows a committed write (unread badge, live
// events of D2, digest mail, repeat-risk report). Route handlers (handlers.ts) authenticate, bound
// and rate-limit first.

/** Messaging is suspended with the deposit when the Firestore write quota is degraded (quotas.ts). */
export const MESSAGING_QUOTAS = ["firestore.writes"] as const satisfies readonly QuotaId[];
/** Accounts younger than this start at most 10 conversations a day (AF §6). */
export const YOUNG_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
/** A seller in one of these states cannot be contacted (D8). */
const SELLER_UNREACHABLE: readonly UserDoc["status"][] = ["banned", "suspended", "closed"];
/** Masking may lengthen a text a little (a 4-character domain becomes a 5-character marker). */
const STORED_TEXT_MAX = MESSAGE_TEXT_MAX + 200;

export interface MessagingActor {
  uid: string;
  claims: Claims;
}

function analyze(text: string): MessageAnalysis {
  const analysis = analyzeMessage(text);
  if (analysis.text.length > STORED_TEXT_MAX) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "text", code: "too_big" }] });
  return analysis;
}

function messageInput(uid: string, original: string, analysis: MessageAnalysis, now: Date): NewMessageInput {
  return { senderUid: uid, text: analysis.text, flags: analysis.flags, ...(analysis.masked ? { original } : {}), now };
}

function accessError(error: unknown): never {
  if (error instanceof ConversationAccessError) {
    if (error.reason === "blocked") throw new HttpError(403, "conversation_blocked");
    // Frozen, or the other account is closed (L7): read-only.
    if (error.reason === "frozen" || error.reason === "closed") throw new HttpError(409, "conversation_unavailable");
    throw notFound();
  }
  throw error;
}

const publicIdOf = (conversation: Pick<ConversationDoc, "buyerUid" | "buyerPublicId" | "sellerPublicId">, uid: string) =>
  conversation.buyerUid === uid ? conversation.buyerPublicId : conversation.sellerPublicId;

/**
 * After a committed message, never failing the send: the recipient's badge, the live events of
 * both participants (D2), the digest mail when the badge goes from 0 to 1 (or cannot be read),
 * then the repeat-risk rule for the sender.
 */
async function afterMessage(input: { cid: string; messageId: string; senderUid: string; senderPublicId: string; recipientUid: string; flags: MessageRiskFlag[]; now: Date }): Promise<void> {
  const total = await recordUnread(input.recipientUid, input.cid);
  await publishNewMessage({ cid: input.cid, mid: input.messageId, senderUid: input.senderUid, recipientUid: input.recipientUid, recipientUnread: total, at: input.now });
  if (total === null || total === 1) await scheduleDigest(input.recipientUid, input.now);
  if (input.flags.length === 0) return;
  if (!(await recordRiskyMessage(input.senderUid, `${input.cid}/${input.messageId}`, input.now))) return;
  try {
    await fileRepeatRiskReport({
      uid: input.senderUid,
      publicId: input.senderPublicId,
      explanation: `Règle automatique de la messagerie : au moins 3 messages à risque en 24 h dans au moins 2 conversations. Drapeaux du dernier message : ${input.flags.join(", ")}.`,
    });
  } catch (error) {
    logger.error({ err: (error as Error).message }, "messaging: repeat-risk report failed");
  }
}

async function append(
  actor: MessagingActor,
  cid: string,
  original: string,
  analysis: MessageAnalysis,
  now: Date,
  extend?: ConversationExtension,
): Promise<{ messageId: string; conversation: ConversationRecord }> {
  let result: Awaited<ReturnType<typeof appendMessage>>;
  try {
    result = await appendMessage(cid, messageInput(actor.uid, original, analysis, now), extend);
  } catch (error) {
    accessError(error);
  }
  await afterMessage({
    cid,
    messageId: result.messageId,
    senderUid: actor.uid,
    senderPublicId: publicIdOf(result.conversation, actor.uid),
    recipientUid: result.recipientUid,
    flags: analysis.flags,
    now,
  });
  return { messageId: result.messageId, conversation: result.conversation };
}

/**
 * First message about a listing (D4, D8): creates the (listing, buyer) conversation, or appends
 * to it when it exists. The caller checked Turnstile, the send limiter and the quota gate. An
 * adults-only listing (decorative koumiyas) needs the buyer's 18+ confirmation, kept on the
 * conversation as `buyerAdultConfirmedAt`.
 */
export async function startConversation(actor: MessagingActor, input: { listingId: string; text: string; adultConfirmed?: boolean }, now = new Date()): Promise<StartConversationResponse> {
  const analysis = analyze(input.text);
  const cid = conversationId(input.listingId, actor.uid);
  const [existing, buyer] = await Promise.all([getConversation(cid), getUserRecord(actor.uid)]);
  if (existing) {
    const { messageId } = await append(actor, cid, input.text, analysis, now);
    return { cid, messageId, existing: true };
  }
  if (!buyer) throw new HttpError(403, "forbidden", "account record missing");
  await enforceLimit("conversation.new.uid", actor.uid);
  if (now.getTime() - buyer.createdAt.getTime() < YOUNG_ACCOUNT_MS) await enforceLimit("conversation.new.young.uid", actor.uid);

  const listing = await getListing(input.listingId);
  // Missing or never public: the same 404 as the listing page. Public but not live, or hidden by a
  // strong signal: 409 (the page shows its banner instead of the contact bar).
  if (!listing || !(PUBLIC_STATES as readonly string[]).includes(listing.status)) throw notFound();
  if (listing.ownerUid === actor.uid || (listing.proId !== undefined && listing.proId === actor.claims.proId)) throw new HttpError(409, "self_conversation");
  if (listing.status !== "published" || listing.moderation.hiddenBy || !listing.slugId) throw new HttpError(409, "listing_unavailable");
  const adultsOnly = Boolean(subcategoryById(listing.subcategoryId ?? "")?.adultsOnly);
  if (adultsOnly && !input.adultConfirmed) throw new HttpError(422, "adult_confirmation_required");

  const [seller, blocks] = await Promise.all([getUserRecord(listing.ownerUid), getUserBlocks([actor.uid, listing.ownerUid])]);
  if (!seller || SELLER_UNREACHABLE.includes(seller.status)) throw new HttpError(409, "listing_unavailable");
  if (isPairBlocked(blocks, actor.uid, seller.uid)) throw new HttpError(403, "conversation_blocked");

  const message = messageInput(actor.uid, input.text, analysis, now);
  const photo = listing.photos[0];
  const conversation: ConversationDoc = {
    listingId: listing.id,
    listingSlugId: listing.slugId,
    sellerUid: seller.uid,
    ...(listing.proId ? { sellerProId: listing.proId } : {}),
    buyerUid: actor.uid,
    participants: [actor.uid, seller.uid],
    sellerName: seller.displayName,
    sellerPublicId: seller.publicId,
    buyerName: buyer.displayName,
    buyerPublicId: buyer.publicId,
    listingSnapshot: { title: listing.title, price: listing.price, isDonation: listing.isDonation, photo: photo ? { id: photo.id, blurhash: photo.blurhash } : null },
    lastMessage: lastMessageOf(message),
    unread: { [seller.uid]: 1, [actor.uid]: 0 },
    blockedBy: [],
    archivedBy: [],
    hiddenFor: [],
    status: "open",
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
    purgeAt: conversationPurgeAt(now),
    legalHold: [],
    ...(adultsOnly ? { buyerAdultConfirmedAt: now } : {}),
  };
  let messageId: string;
  try {
    messageId = await createConversation(cid, conversation, message);
  } catch (error) {
    if (!(error instanceof ConversationExistsError)) throw error;
    // Two first messages raced: the second one is appended.
    const appended = await append(actor, cid, input.text, analysis, now);
    return { cid, messageId: appended.messageId, existing: true };
  }
  await afterMessage({ cid, messageId, senderUid: actor.uid, senderPublicId: buyer.publicId, recipientUid: seller.uid, flags: analysis.flags, now });
  return { cid, messageId, existing: false };
}

/** A message in an existing conversation (D4): participants only, not blocked, not frozen. */
export async function sendMessage(actor: MessagingActor, cid: string, text: string, now = new Date()): Promise<SendMessageResponse> {
  const analysis = analyze(text);
  const { messageId } = await append(actor, cid, text, analysis, now);
  return { messageId, flags: analysis.flags };
}

/**
 * An appointment step (src/lib/appointments): a system message whose text and conversation fields
 * `extend` sets inside the append transaction (same access checks as a message), then what follows
 * every message (the other participant's badge, live events, digest mail).
 */
export async function appendAppointmentStep(actor: MessagingActor, cid: string, extend: ConversationExtension, now = new Date()): Promise<string> {
  const { messageId } = await append(actor, cid, "", { text: "", flags: [], masked: false }, now, extend);
  return messageId;
}

/** Read receipt (D7); the badge forgets the conversation either way. Live receipt when something changed. */
export async function readConversation(uid: string, cid: string, now = new Date()): Promise<void> {
  let other: string | null = null;
  try {
    other = await markConversationRead(cid, uid, now);
  } catch (error) {
    accessError(error);
  }
  const total = await clearUnread(uid, cid);
  if (other) await publishRead({ cid, readerUid: uid, otherUid: other, readerUnread: total, at: now });
}

export type StateChange = { archived: boolean } | { hidden: true } | { blocked: boolean };

/**
 * Archive, delete for me, block or unblock the other participant (D6, D7). A block is account
 * wide: userBlocks/{uid}, mirrored as `blockedBy` on every conversation between the two accounts.
 */
export async function changeConversationState(uid: string, cid: string, change: StateChange, now = new Date()): Promise<void> {
  try {
    if ("blocked" in change) {
      const conversation = await getParticipantConversation(cid, uid);
      const other = counterpartOf(conversation, uid);
      let changed: boolean;
      try {
        changed = await setUserBlock(uid, other, change.blocked, now);
      } catch (error) {
        if (error instanceof BlockListFullError) throw new HttpError(409, "conflict", "block list full");
        throw error;
      }
      if (changed || conversation.blockedBy.includes(uid) !== change.blocked) await setPairBlockedBy(uid, other, change.blocked);
      // Both rows show the block (blockedByMe, blockedMe); the pair's other conversations follow on refetch.
      await publishConversationChange(cid, [uid, other], now);
      return;
    }
    await setParticipantState(cid, uid, change);
  } catch (error) {
    accessError(error);
  }
  // Archive and delete for me concern this account only (its other tabs).
  if ("hidden" in change) await publishConversationChange(cid, [uid], now, { uid, total: await clearUnread(uid, cid) });
  else await publishConversationChange(cid, [uid], now);
}

/** Total of `uid`'s unread messages (Valkey, rebuilt from Firestore when missing). */
export async function readUnreadTotal(uid: string): Promise<number> {
  return unreadTotal(uid, () => unreadCounts(uid));
}

/** GET /api/messages/unread: the total, 503 when Valkey fails; marks the account as active (digest). */
export async function unreadBadge(uid: string): Promise<number> {
  let total: number;
  try {
    total = await readUnreadTotal(uid);
  } catch (error) {
    if (error instanceof UnreadUnavailableError) throw unavailable("unread counters unavailable");
    throw error;
  }
  await markSeen(uid);
  return total;
}
