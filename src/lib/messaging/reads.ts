import "server-only";
import type { QuotaId } from "@/config/quotas";
import { INBOX_PAGE, THREAD_PAGE, type ConversationResponse, type ConversationsPage, type MessagesPage } from "@/lib/contracts/messaging";
import { notFound } from "@/lib/http/errors";
import { getConversation, listInboxPage, listThreadPage, type ConversationRecord, type PagePosition } from "./repository";
import { conversationView, encodeCursor, isVisibleTo, messageView } from "./views";

// What the browser reads of its conversations (design D2, revised 19 Oct: never Firestore itself).
// Participants only: anyone else, and a participant who deleted the conversation for himself (D7),
// gets 404. Each read returns the documents it cost, charged by the route on the account's budget.

/** Reading conversations stops with the Firestore read quota (503 quota_exhausted until the reset). */
export const MESSAGING_READ_QUOTAS = ["firestore.reads"] as const satisfies readonly QuotaId[];

export interface Charged<T> {
  body: T;
  /** Firestore documents read. */
  reads: number;
}

/**
 * One inbox page: INBOX_PAGE conversations scanned newest activity first, without the ones
 * deleted for me, and either without the archived ones or (archived) only them.
 */
export async function inboxPage(uid: string, options: { cursor?: PagePosition; archived?: boolean } = {}): Promise<Charged<ConversationsPage>> {
  const page = await listInboxPage(uid, INBOX_PAGE, options.cursor);
  const wanted = options.archived === true;
  const conversations = page.items.filter((conversation) => isVisibleTo(conversation, uid) && conversation.archivedBy.includes(uid) === wanted).map((conversation) => conversationView(conversation, uid));
  return { body: { conversations, ...(page.next ? { next: encodeCursor(page.next) } : {}) }, reads: page.reads };
}

async function visibleConversation(uid: string, cid: string): Promise<ConversationRecord> {
  const conversation = await getConversation(cid);
  if (!conversation || !isVisibleTo(conversation, uid)) throw notFound();
  return conversation;
}

/** One inbox row (one read). */
export async function conversationRow(uid: string, cid: string): Promise<Charged<ConversationResponse>> {
  return { body: { conversation: conversationView(await visibleConversation(uid, cid), uid) }, reads: 1 };
}

/**
 * One thread page with its conversation: the THREAD_PAGE newest messages, the older page after
 * `before`, or only the messages newer than `after` (`gap` when more than a page of them exist).
 */
export async function threadPage(uid: string, cid: string, range: { before?: PagePosition; after?: PagePosition } = {}): Promise<Charged<MessagesPage>> {
  const conversation = await visibleConversation(uid, cid);
  const page = await listThreadPage(cid, THREAD_PAGE, range);
  // `latest` comes with the first page and the newer messages: an older page is not the thread's end.
  const newest = page.items[0];
  const latest = range.before ? undefined : newest ? { at: newest.createdAt, id: newest.id } : range.after;
  const body: MessagesPage = {
    conversation: conversationView(conversation, uid),
    messages: page.items.map((message) => messageView(message, uid)),
    ...(range.after ? (page.more ? { gap: true } : {}) : page.next ? { next: encodeCursor(page.next) } : {}),
    ...(latest ? { latest: encodeCursor(latest) } : {}),
  };
  return { body, reads: 1 + page.reads };
}
