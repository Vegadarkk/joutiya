import "server-only";
import { FieldPath, FieldValue, Timestamp, type DocumentSnapshot, type Query, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { HIDDEN_MARKER, type MessageRiskFlag } from "@/lib/contracts/messaging";
import {
  COLLECTIONS,
  conversationSchema,
  messageEvidenceSchema,
  messageSchema,
  userBlocksSchema,
  type ConversationDoc,
  type MessageDoc,
  type MessageEvidenceDoc,
} from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { maskLinks, messagePreview } from "./risk";

// conversations/{cid}, their messages and evidence, userBlocks/{uid} (design D4-D7, D18). The
// server is the only writer (rules deny every client write); every read and write is counted
// against the Spark quotas. A message costs one transaction: the conversation read and the block
// lists of both participants, then the message, the conversation update and, for a masked text,
// its evidence. Dates: Timestamp in Firestore, Date in memory.

export interface ConversationRecord extends ConversationDoc {
  cid: string;
}

export interface MessageRecord extends MessageDoc {
  id: string;
}

/** Retention of a conversation after its last activity (AF §7). */
export const CONVERSATION_RETENTION_MONTHS = 12;
/** Inbox window rebuilt for the unread badge (D3). */
export const UNREAD_REBUILD_LIMIT = 50;
/** Most messages the staff view returns (D18). */
export const STAFF_MESSAGES_MAX = 200;
export const USER_BLOCKS_MAX = 500;
/** Holds that freeze a conversation (D17 authority requests; disputes later). */
export const FREEZE_HOLD_PREFIXES = ["authority:", "dispute:", "freeze:"] as const;

const ALREADY_EXISTS = 6;

export class ConversationAccessError extends Error {
  constructor(readonly reason: "missing" | "blocked" | "frozen" | "closed") {
    super(`conversation ${reason}`);
    this.name = "ConversationAccessError";
  }
}

export class ConversationExistsError extends Error {
  constructor() {
    super("conversation already exists");
    this.name = "ConversationExistsError";
  }
}

export class BlockListFullError extends Error {
  constructor() {
    super("block list full");
    this.name = "BlockListFullError";
  }
}

export function addMonths(from: Date, months: number): Date {
  const date = new Date(from.getTime());
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

export const conversationPurgeAt = (lastActivity: Date) => addMonths(lastActivity, CONVERSATION_RETENTION_MONTHS);

const conversations = () => db().collection(COLLECTIONS.conversations);
export const conversationRef = (cid: string) => conversations().doc(cid);
export const messagesRef = (cid: string) => conversationRef(cid).collection(COLLECTIONS.messages);
export const evidenceRef = (cid: string, mid: string) => conversationRef(cid).collection(COLLECTIONS.evidence).doc(mid);
export const userBlocksRef = (uid: string) => db().collection(COLLECTIONS.userBlocks).doc(uid);

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

export function conversationFromSnapshot(snapshot: DocumentSnapshot): ConversationRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = conversationSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { cid: snapshot.id, ...parsed.data } : null;
}

export function messageFromSnapshot(snapshot: DocumentSnapshot): MessageRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = messageSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

function evidenceFromSnapshot(snapshot: DocumentSnapshot): MessageEvidenceDoc | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = messageEvidenceSchema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

const toFirestore = <T>(value: T): Record<string, unknown> => datesToTimestamps(value) as Record<string, unknown>;

export const isParticipant = (conversation: Pick<ConversationDoc, "participants">, uid: string) => conversation.participants.includes(uid);
export const counterpartOf = (conversation: Pick<ConversationDoc, "participants">, uid: string): string => conversation.participants.find((participant) => participant !== uid) ?? uid;

export async function getConversation(cid: string): Promise<ConversationRecord | null> {
  const snapshot = await conversationRef(cid).get();
  void consume("firestore.reads", 1);
  return conversationFromSnapshot(snapshot);
}

/** uid -> blocked uids, from userBlocks snapshots (missing document: nobody). */
export function blocksOf(snapshots: readonly DocumentSnapshot[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const parsed = userBlocksSchema.safeParse(timestampsToDates(snapshot.data() ?? {}));
    out.set(snapshot.id, parsed.success ? parsed.data.uids : []);
  }
  return out;
}

/** Blocked uids of each account (missing document: nobody). */
export async function getUserBlocks(uids: readonly string[]): Promise<Map<string, string[]>> {
  const snapshots = await db().getAll(...uids.map((uid) => userBlocksRef(uid)));
  void consume("firestore.reads", snapshots.length);
  return blocksOf(snapshots);
}

/** True when either account blocked the other (D6). */
export const isPairBlocked = (blocks: Map<string, string[]>, a: string, b: string): boolean => (blocks.get(a)?.includes(b) ?? false) || (blocks.get(b)?.includes(a) ?? false);

export interface NewMessageInput {
  senderUid: string;
  /** Stored text (links masked). */
  text: string;
  flags: MessageRiskFlag[];
  /** Original text, kept as evidence when links were masked. */
  original?: string;
  /** A system message about the conversation's appointment (src/lib/appointments). */
  appointment?: MessageDoc["appointment"];
  /** A system message about the conversation's booking request (src/lib/rental-requests). */
  rentalRequest?: MessageDoc["rentalRequest"];
  now: Date;
}

/**
 * Runs inside the append transaction on the conversation as read (src/lib/appointments,
 * src/lib/rental-requests): throws to abort, else returns the conversation fields to set with the
 * message (null deletes a field) and, for a system message, its text and appointment or booking
 * request step.
 */
export type ConversationExtension = (conversation: ConversationRecord) => {
  fields: Partial<Record<"appointment" | "appointmentRemindAt" | "rentalRequest", unknown>>;
  message?: Pick<NewMessageInput, "text"> & (Required<Pick<NewMessageInput, "appointment">> | Required<Pick<NewMessageInput, "rentalRequest">>);
};

function messageDoc(conversation: Pick<ConversationDoc, "participants" | "sellerProId">, input: NewMessageInput): MessageDoc {
  return messageSchema.parse({
    senderUid: input.senderUid,
    participants: conversation.participants,
    ...(conversation.sellerProId ? { sellerProId: conversation.sellerProId } : {}),
    type: input.appointment || input.rentalRequest ? "system" : "text",
    ...(input.appointment ? { appointment: input.appointment } : {}),
    ...(input.rentalRequest ? { rentalRequest: input.rentalRequest } : {}),
    text: input.text,
    ...(input.flags.length > 0 ? { risk: { flags: input.flags, warned: true } } : {}),
    createdAt: input.now,
  });
}

function evidenceDoc(input: NewMessageInput): MessageEvidenceDoc | null {
  if (input.original === undefined) return null;
  return messageEvidenceSchema.parse({ text: input.original, flags: input.flags, reason: "masked", createdAt: input.now });
}

export function lastMessageOf(input: NewMessageInput): ConversationDoc["lastMessage"] {
  return { preview: messagePreview(input.text), senderUid: input.senderUid, at: input.now, flagged: input.flags.length > 0 };
}

/**
 * Creates the conversation with its first message (one batch: all or nothing). Throws
 * ConversationExistsError when the cid already exists (the caller appends instead).
 */
export async function createConversation(cid: string, conversation: ConversationDoc, input: NewMessageInput): Promise<string> {
  const doc = conversationSchema.parse(conversation);
  const message = messageDoc(doc, input);
  const evidence = evidenceDoc(input);
  const messageRef = messagesRef(cid).doc();
  const batch = db().batch();
  batch.create(conversationRef(cid), toFirestore(doc));
  batch.set(messageRef, toFirestore(message));
  if (evidence) batch.set(evidenceRef(cid, messageRef.id), toFirestore(evidence));
  try {
    await batch.commit();
  } catch (error) {
    if (codeOf(error) === ALREADY_EXISTS) throw new ConversationExistsError();
    throw error;
  }
  void consume("firestore.writes", evidence ? 3 : 2);
  return messageRef.id;
}

export interface AppendResult {
  messageId: string;
  /** The conversation before the message. */
  conversation: ConversationRecord;
  recipientUid: string;
}

/**
 * Appends a message (D4, D7) in one transaction: the sender must be a participant (else
 * "missing"), nobody blocked the other ("blocked": the `blockedBy` mirror, then the userBlocks
 * lists of both accounts, which decide, audit D1a-10), the conversation is not frozen ("frozen"),
 * no participant closed the account ("closed", L7).
 * The recipient's unread count + 1; archive and delete-for-me are lifted for both participants.
 * `extend` adds conversation fields to the same transaction (appointments, booking requests), after these checks.
 */
export async function appendMessage(cid: string, given: NewMessageInput, extend?: ConversationExtension): Promise<AppendResult> {
  const messageRef = messagesRef(cid).doc();
  const result = await db().runTransaction(async (tx) => {
    const conversation = conversationFromSnapshot(await tx.get(conversationRef(cid)));
    let input = given;
    if (!conversation || !isParticipant(conversation, input.senderUid)) throw new ConversationAccessError("missing");
    if (conversation.blockedBy.length > 0) throw new ConversationAccessError("blocked");
    const recipientUid = counterpartOf(conversation, input.senderUid);
    const blocks = blocksOf(await tx.getAll(userBlocksRef(input.senderUid), userBlocksRef(recipientUid)));
    if (isPairBlocked(blocks, input.senderUid, recipientUid)) throw new ConversationAccessError("blocked");
    if (conversation.status === "frozen") throw new ConversationAccessError("frozen");
    // A participant closed the account (L7): the other one keeps reading, nobody writes.
    if ((conversation.accountClosed ?? []).length > 0) throw new ConversationAccessError("closed");
    const extension = extend?.(conversation);
    const extra = extension?.fields ?? {};
    if (extension?.message) input = { ...input, ...extension.message };
    const message = messageDoc(conversation, input);
    const evidence = evidenceDoc(input);
    const { cid: _cid, ...rest } = conversation;
    const cleared = Object.keys(extra).filter((key) => extra[key as keyof typeof extra] === null);
    const current = Object.fromEntries(Object.entries(rest).filter(([key]) => !cleared.includes(key)));
    const next = conversationSchema.parse({
      ...current,
      lastMessage: lastMessageOf(input),
      unread: { ...conversation.unread, [recipientUid]: (conversation.unread[recipientUid] ?? 0) + 1 },
      archivedBy: [],
      hiddenFor: [],
      messageCount: conversation.messageCount + 1,
      updatedAt: input.now,
      purgeAt: conversationPurgeAt(input.now),
      ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null)),
    });
    // The seller's first message makes the exchange reciprocal: it opens the buyer's review (vitrine-avis §2).
    const sellerReplies = input.senderUid === conversation.sellerUid && !conversation.sellerRepliedAt;
    tx.set(messageRef, toFirestore(message));
    if (evidence) tx.set(evidenceRef(cid, messageRef.id), toFirestore(evidence));
    tx.update(
      conversationRef(cid),
      toFirestore({
        lastMessage: next.lastMessage,
        unread: next.unread,
        archivedBy: next.archivedBy,
        hiddenFor: next.hiddenFor,
        messageCount: next.messageCount,
        updatedAt: next.updatedAt,
        purgeAt: next.purgeAt,
        ...Object.fromEntries(Object.keys(extra).map((key) => [key, cleared.includes(key) ? FieldValue.delete() : next[key as keyof typeof extra]])),
        ...(sellerReplies ? { sellerRepliedAt: input.now } : {}),
      }),
    );
    return { conversation, recipientUid, writes: evidence ? 3 : 2 };
  });
  void consume("firestore.reads", 3);
  void consume("firestore.writes", result.writes);
  return { messageId: messageRef.id, conversation: result.conversation, recipientUid: result.recipientUid };
}

/** The conversation when `uid` takes part in it, else ConversationAccessError("missing"). */
async function participantConversationTx(tx: Transaction, cid: string, uid: string): Promise<ConversationRecord> {
  const conversation = conversationFromSnapshot(await tx.get(conversationRef(cid)));
  if (!conversation || !isParticipant(conversation, uid)) throw new ConversationAccessError("missing");
  return conversation;
}

/** The conversation when `uid` takes part in it (one read), else ConversationAccessError("missing"). */
export async function getParticipantConversation(cid: string, uid: string): Promise<ConversationRecord> {
  const conversation = await getConversation(cid);
  if (!conversation || !isParticipant(conversation, uid)) throw new ConversationAccessError("missing");
  return conversation;
}

/**
 * Read receipt (D7): zeroes `unread[uid]` and sets `readAt` on the newest message of the other
 * participant only. No write when nothing was unread. Returns the other participant's uid when
 * something changed (the live receipt goes to him), else null.
 */
export async function markConversationRead(cid: string, uid: string, now: Date): Promise<string | null> {
  const { writes, other } = await db().runTransaction(async (tx) => {
    const conversation = await participantConversationTx(tx, cid, uid);
    const counterpart = counterpartOf(conversation, uid);
    if ((conversation.unread[uid] ?? 0) === 0) return { writes: 0, other: counterpart };
    const incoming = await tx.get(messagesRef(cid).where("senderUid", "==", counterpart).orderBy("createdAt", "desc").limit(1));
    const newest = incoming.docs[0];
    tx.update(conversationRef(cid), { unread: { ...conversation.unread, [uid]: 0 } });
    if (newest && !newest.get("readAt")) {
      tx.update(newest.ref, { readAt: Timestamp.fromDate(now) });
      return { writes: 2, other: counterpart };
    }
    return { writes: 1, other: counterpart };
  });
  void consume("firestore.reads", writes > 0 ? 2 : 1);
  if (writes > 0) void consume("firestore.writes", writes);
  return writes > 0 ? other : null;
}

export type ParticipantState = { archived: boolean } | { hidden: true };

/**
 * Archive / unarchive, or delete for me (D7: `hiddenFor`, the unread count goes with it). Neither
 * touches `updatedAt` (the inbox order). Returns the conversation before the change.
 */
export async function setParticipantState(cid: string, uid: string, change: ParticipantState): Promise<ConversationRecord> {
  const conversation = await db().runTransaction(async (tx) => {
    const current = await participantConversationTx(tx, cid, uid);
    if ("hidden" in change) {
      tx.update(conversationRef(cid), { hiddenFor: FieldValue.arrayUnion(uid), unread: { ...current.unread, [uid]: 0 } });
    } else {
      tx.update(conversationRef(cid), { archivedBy: change.archived ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid) });
    }
    return current;
  });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  return conversation;
}

/**
 * Adds or removes `other` in userBlocks/{uid} (<= 500, BlockListFullError beyond). True when the
 * list changed.
 */
export async function setUserBlock(uid: string, other: string, blocked: boolean, now: Date): Promise<boolean> {
  const changed = await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(userBlocksRef(uid));
    const parsed = userBlocksSchema.safeParse(timestampsToDates(snapshot.data() ?? {}));
    const uids = parsed.success ? parsed.data.uids : [];
    if (blocked === uids.includes(other)) return false;
    if (blocked && uids.length >= USER_BLOCKS_MAX) throw new BlockListFullError();
    const next = blocked ? [...uids, other] : uids.filter((value) => value !== other);
    tx.set(userBlocksRef(uid), toFirestore(userBlocksSchema.parse({ uids: next, updatedAt: now })));
    return true;
  });
  void consume("firestore.reads", 1);
  if (changed) void consume("firestore.writes", 1);
  return changed;
}

/** Conversations of a pair mirrored per page (one batch each), and the most pages per direction. */
export const MIRROR_PAGE = 100;
export const MIRROR_MAX_PAGES = 50;

/** Updates `blockedBy` on every document of `base`, page after page (implicit `__name__` cursor). */
async function mirrorBlockedBy(base: Query, blocker: string, blocked: boolean): Promise<number> {
  const change = blocked ? FieldValue.arrayUnion(blocker) : FieldValue.arrayRemove(blocker);
  let updated = 0;
  let after: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MIRROR_MAX_PAGES; page += 1) {
    const snapshot = await (after ? base.startAfter(after) : base).limit(MIRROR_PAGE).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    if (snapshot.empty) break;
    const batch = db().batch();
    for (const doc of snapshot.docs) batch.update(doc.ref, { blockedBy: change });
    await batch.commit();
    void consume("firestore.writes", snapshot.size);
    updated += snapshot.size;
    if (snapshot.size < MIRROR_PAGE) break;
    after = snapshot.docs[snapshot.size - 1];
  }
  return updated;
}

/**
 * Mirrors an account-level block on every conversation between the two accounts (`blockedBy`): the
 * inbox shows it without reading userBlocks, and a send refuses on it before reading them (the
 * lists decide either way, audit D1a-10). Paged until exhausted (MIRROR_MAX_PAGES x MIRROR_PAGE
 * per direction). Equality filters only: Firestore merges the single-field indexes of buyerUid and
 * sellerUid. Returns the number of conversations updated.
 */
export async function setPairBlockedBy(blocker: string, other: string, blocked: boolean): Promise<number> {
  const [asBuyer, asSeller] = await Promise.all([
    mirrorBlockedBy(conversations().where("buyerUid", "==", blocker).where("sellerUid", "==", other), blocker, blocked),
    mirrorBlockedBy(conversations().where("buyerUid", "==", other).where("sellerUid", "==", blocker), blocker, blocked),
  ]);
  return asBuyer + asSeller;
}

/**
 * Account closure (L7): `uid` joins `accountClosed` on every conversation it takes part in, page
 * after page (the participants array-contains index, implicit `__name__` order), at most
 * MIRROR_MAX_PAGES x MIRROR_PAGE. Returns each conversation updated with its other participant.
 */
export async function markAccountClosed(uid: string): Promise<{ cid: string; other: string }[]> {
  const base = conversations().where("participants", "array-contains", uid);
  const updated: { cid: string; other: string }[] = [];
  let after: QueryDocumentSnapshot | undefined;
  for (let page = 0; page < MIRROR_MAX_PAGES; page += 1) {
    const snapshot = await (after ? base.startAfter(after) : base).limit(MIRROR_PAGE).select("participants").get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    if (snapshot.empty) break;
    const batch = db().batch();
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, { accountClosed: FieldValue.arrayUnion(uid) });
      const participants: unknown = doc.get("participants");
      const other = Array.isArray(participants) ? participants.find((participant): participant is string => typeof participant === "string" && participant !== uid) : undefined;
      updated.push({ cid: doc.id, other: other ?? uid });
    }
    await batch.commit();
    void consume("firestore.writes", snapshot.size);
    if (snapshot.size < MIRROR_PAGE) break;
    after = snapshot.docs[snapshot.size - 1];
  }
  return updated;
}

/** cid -> unread count of `uid` over its newest conversations (the badge rebuild, D3). */
export async function unreadCounts(uid: string, limit = UNREAD_REBUILD_LIMIT): Promise<Record<string, number>> {
  const snapshot = await conversations().where("participants", "array-contains", uid).orderBy("updatedAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const out: Record<string, number> = {};
  for (const doc of snapshot.docs) {
    const count = Number((doc.get("unread") as Record<string, unknown> | undefined)?.[uid] ?? 0);
    if (Number.isInteger(count) && count > 0) out[doc.id] = count;
  }
  return out;
}

export interface UnreadSummaryItem {
  cid: string;
  listingTitle: string;
  /** Display name of the other participant. */
  counterpartName: string;
  unread: number;
}

/**
 * What the grouped new-messages mail shows (D21, job message-digest): the unread total over the
 * newest conversations and the `items` most recent ones with unread messages. No message text.
 */
export async function unreadSummary(uid: string, options: { limit?: number; items?: number } = {}): Promise<{ total: number; items: UnreadSummaryItem[] }> {
  const snapshot = await conversations()
    .where("participants", "array-contains", uid)
    .orderBy("updatedAt", "desc")
    .limit(options.limit ?? UNREAD_REBUILD_LIMIT)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  let total = 0;
  const items: UnreadSummaryItem[] = [];
  for (const doc of snapshot.docs) {
    const conversation = conversationFromSnapshot(doc);
    const count = conversation?.unread[uid] ?? 0;
    if (!conversation || count <= 0) continue;
    total += count;
    if (items.length < (options.items ?? 3)) {
      items.push({ cid: conversation.cid, listingTitle: conversation.listingSnapshot.title, counterpartName: conversation.buyerUid === uid ? conversation.sellerName : conversation.buyerName, unread: count });
    }
  }
  return { total, items };
}

// ---- Participant reads (D2: the browser reads through the API only) -------------------------

/** Position in a newest-first list: the sort time and the document id (ties broken by id). */
export interface PagePosition {
  at: Date;
  id: string;
}

export interface ReadPage<T> {
  items: T[];
  /** Position of the last item when an older page follows. */
  next?: PagePosition;
  /** More documents matched than `limit` (an `after` read left newer ones out). */
  more: boolean;
  /** Documents read (Spark charges one for an empty result). */
  reads: number;
}

function pageOf<T>(docs: readonly QueryDocumentSnapshot[], limit: number, field: string, parse: (doc: QueryDocumentSnapshot) => T | null): ReadPage<T> {
  const kept = docs.slice(0, limit);
  const last = kept[kept.length - 1];
  const at: unknown = last?.get(field);
  const more = docs.length > limit;
  return {
    items: kept.map(parse).filter((item): item is T => item !== null),
    ...(more && last && at instanceof Timestamp ? { next: { at: at.toDate(), id: last.id } } : {}),
    more,
    reads: Math.max(1, docs.length),
  };
}

/**
 * One inbox page of `uid`: the `limit` conversations with the newest activity after `cursor`
 * (updatedAt desc, then id desc; the participants + updatedAt index), whatever their archive or
 * delete-for-me state (the caller filters). Reads one document more to know whether a page follows.
 */
export async function listInboxPage(uid: string, limit: number, cursor?: PagePosition): Promise<ReadPage<ConversationRecord>> {
  let query = conversations().where("participants", "array-contains", uid).orderBy("updatedAt", "desc").orderBy(FieldPath.documentId(), "desc");
  if (cursor) query = query.startAfter(Timestamp.fromDate(cursor.at), cursor.id);
  const snapshot = await query.limit(limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return pageOf(snapshot.docs, limit, "updatedAt", conversationFromSnapshot);
}

/**
 * One thread page, newest first (createdAt desc, then id desc): the `limit` newest messages, those
 * older than `before`, or the `limit` newest of those newer than `after` (`more` when some newer
 * ones were left out). Reads one document more than `limit`.
 */
export async function listThreadPage(cid: string, limit: number, range: { before?: PagePosition; after?: PagePosition } = {}): Promise<ReadPage<MessageRecord>> {
  let query = messagesRef(cid).orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
  if (range.before) query = query.startAfter(Timestamp.fromDate(range.before.at), range.before.id);
  if (range.after) query = query.endBefore(Timestamp.fromDate(range.after.at), range.after.id);
  const snapshot = await query.limit(limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return pageOf(snapshot.docs, limit, "createdAt", messageFromSnapshot);
}

// ---- Staff and moderation (D11, D17, D18) ---------------------------------------------------

export interface ConversationTranscript {
  conversation: ConversationRecord;
  /** Newest first. */
  messages: MessageRecord[];
  /** Original texts by message id (masked or hidden messages). */
  evidence: Record<string, MessageEvidenceDoc>;
}

/**
 * The conversation, its `limit` newest messages, and the evidence of `evidenceFor` (default: every
 * evidence document of those messages). Null when the conversation does not exist.
 */
export async function readTranscript(cid: string, limit: number, evidenceFor?: readonly string[]): Promise<ConversationTranscript | null> {
  const conversation = await getConversation(cid);
  if (!conversation) return null;
  const size = Math.max(1, Math.min(STAFF_MESSAGES_MAX, Math.floor(limit)));
  const snapshot = await messagesRef(cid).orderBy("createdAt", "desc").limit(size).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const messages = snapshot.docs.map(messageFromSnapshot).filter((message): message is MessageRecord => message !== null);
  const inWindow = new Set(messages.map((message) => message.id));
  const wanted = (evidenceFor ?? messages.map((message) => message.id)).filter((mid) => inWindow.has(mid));
  const evidence: Record<string, MessageEvidenceDoc> = {};
  if (wanted.length > 0) {
    const snapshots = await db().getAll(...wanted.map((mid) => evidenceRef(cid, mid)));
    void consume("firestore.reads", snapshots.length);
    for (const item of snapshots) {
      const parsed = evidenceFromSnapshot(item);
      if (parsed) evidence[item.id] = parsed;
    }
  }
  return { conversation, messages, evidence };
}

/** True when the conversation's lastMessage is this message (same sender, same time). */
function isLastMessage(conversation: ConversationRecord, message: MessageRecord): boolean {
  return conversation.lastMessage.senderUid === message.senderUid && conversation.lastMessage.at.getTime() === message.createdAt.getTime();
}

/**
 * Hides a message (D11, D13): text replaced by HIDDEN_MARKER, original kept in evidence (an
 * existing "masked" evidence already holds it). Returns the participants (the live event goes to
 * them), or null when the message is missing or already hidden.
 */
export async function hideMessageDoc(cid: string, mid: string, now: Date): Promise<readonly string[] | null> {
  const changed = await db().runTransaction(async (tx) => {
    const [messageSnap, evidenceSnap, conversationSnap] = await Promise.all([tx.get(messagesRef(cid).doc(mid)), tx.get(evidenceRef(cid, mid)), tx.get(conversationRef(cid))]);
    const message = messageFromSnapshot(messageSnap);
    if (!message || message.hidden) return null;
    const evidence = evidenceFromSnapshot(evidenceSnap);
    if (evidence) tx.update(evidenceRef(cid, mid), { reason: "hidden" });
    else {
      const original = messageEvidenceSchema.parse({ text: message.text.slice(0, 2000), flags: message.risk?.flags ?? [], reason: "hidden", createdAt: now });
      tx.set(evidenceRef(cid, mid), toFirestore(original));
    }
    tx.update(messagesRef(cid).doc(mid), { text: HIDDEN_MARKER, hidden: true });
    const conversation = conversationFromSnapshot(conversationSnap);
    if (conversation && isLastMessage(conversation, message)) tx.update(conversationRef(cid), { "lastMessage.preview": HIDDEN_MARKER });
    return message.participants;
  });
  void consume("firestore.reads", 3);
  if (changed) void consume("firestore.writes", 3);
  return changed;
}

/**
 * Restores a hidden message from its evidence (links masked again; the evidence stays as "masked"
 * when there were links, else it is deleted). Returns the participants, or null when the message
 * is missing, not hidden, or has no evidence to restore from.
 */
export async function unhideMessageDoc(cid: string, mid: string): Promise<readonly string[] | null> {
  const changed = await db().runTransaction(async (tx) => {
    const [messageSnap, evidenceSnap, conversationSnap] = await Promise.all([tx.get(messagesRef(cid).doc(mid)), tx.get(evidenceRef(cid, mid)), tx.get(conversationRef(cid))]);
    const message = messageFromSnapshot(messageSnap);
    const evidence = evidenceFromSnapshot(evidenceSnap);
    if (!message?.hidden || !evidence) return null;
    const restored = maskLinks(evidence.text);
    tx.update(messagesRef(cid).doc(mid), { text: restored.text, hidden: FieldValue.delete() });
    if (restored.count > 0) tx.update(evidenceRef(cid, mid), { reason: "masked" });
    else tx.delete(evidenceRef(cid, mid));
    const conversation = conversationFromSnapshot(conversationSnap);
    if (conversation && isLastMessage(conversation, message)) tx.update(conversationRef(cid), { "lastMessage.preview": messagePreview(restored.text) });
    return message.participants;
  });
  void consume("firestore.reads", 3);
  if (changed) void consume("firestore.writes", 3);
  return changed;
}

export const isFreezeHold = (hold: string) => FREEZE_HOLD_PREFIXES.some((prefix) => hold.startsWith(prefix));

export interface HoldChange {
  participants: readonly string[];
  /** The conversation was frozen or reopened (visible to its participants). */
  statusChanged: boolean;
}

/**
 * Adds or removes a legal hold (D10, D17). `freeze`: the hold also freezes the conversation (on),
 * and removing it reopens the conversation unless another freezing hold remains. Null when the
 * conversation does not exist or nothing changed. Throws when 50 holds are already set (schema bound).
 */
export async function setConversationHoldDoc(cid: string, holdId: string, on: boolean, options: { freeze?: boolean } = {}): Promise<HoldChange | null> {
  const changed = await db().runTransaction(async (tx): Promise<HoldChange | null> => {
    const conversation = conversationFromSnapshot(await tx.get(conversationRef(cid)));
    if (!conversation) return null;
    const holds = on ? [...new Set([...conversation.legalHold, holdId])] : conversation.legalHold.filter((hold) => hold !== holdId);
    if (holds.length > 50) throw new Error("conversation legal hold list full");
    let status = conversation.status;
    if (options.freeze) status = on || holds.some(isFreezeHold) ? "frozen" : "open";
    if (holds.length === conversation.legalHold.length && status === conversation.status) return null;
    tx.update(conversationRef(cid), { legalHold: holds, status });
    return { participants: conversation.participants, statusChanged: status !== conversation.status };
  });
  void consume("firestore.reads", 1);
  if (changed) void consume("firestore.writes", 1);
  return changed;
}
