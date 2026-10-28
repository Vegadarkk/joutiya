import { apiGet, apiPost } from "@/lib/auth/client";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type {
  ConversationResponse,
  ConversationsPage,
  ConversationStateRequest,
  MessagesPage,
  SendMessageResponse,
  StartConversationRequest,
  StartConversationResponse,
  UnreadResponse,
} from "@/lib/contracts/messaging";

// Browser side of the messaging API (design phase-5 D2-D9): same-origin JSON calls with the CSRF
// header (lib/auth/client). The browser never reads Firestore; live changes arrive as event ids on
// the stream (live.ts) and are fetched here. Type-only imports from contracts/messaging: no zod in
// the header's badge chunk.

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** GET one inbox page (newest activity first); `archived` lists the archived conversations only. */
export function fetchInbox(options: { cursor?: string; archived?: boolean } = {}): Promise<ConversationsPage> {
  return apiGet<ConversationsPage>(withQuery(MESSAGING_API.conversations, { cursor: options.cursor, archived: options.archived ? "1" : undefined }));
}

/**
 * My conversation as the buyer of `listingId` among my most recent ones (first inbox page), or
 * null. A shortcut for the listing's message button: when it misses (older or archived), the
 * first-message dialog still lands in the same conversation (the server appends to it).
 */
export async function findListingConversation(listingId: string): Promise<string | null> {
  const page = await fetchInbox();
  return page.conversations.find((row) => row.listingId === listingId && row.role === "buyer")?.cid ?? null;
}

/** GET one inbox row (404 when deleted for me or not mine). */
export function fetchConversation(cid: string): Promise<ConversationResponse> {
  return apiGet<ConversationResponse>(MESSAGING_API.conversation(cid));
}

/** GET a thread page: the newest one, the older page before `cursor`, or the messages after `after`. */
export function fetchThread(cid: string, range: { cursor?: string; after?: string } = {}): Promise<MessagesPage> {
  return apiGet<MessagesPage>(withQuery(MESSAGING_API.messages(cid), { cursor: range.cursor, after: range.after }));
}

/** POST the first message about a listing (Turnstile token of the "message" action). */
export function startConversation(input: StartConversationRequest): Promise<StartConversationResponse> {
  return apiPost<StartConversationResponse>(MESSAGING_API.conversations, input);
}

export function sendMessage(cid: string, text: string): Promise<SendMessageResponse> {
  return apiPost<SendMessageResponse>(MESSAGING_API.messages(cid), { text });
}

/** POST the read receipt: my unread count of `cid` goes to zero. */
export function markConversationRead(cid: string): Promise<void> {
  return apiPost<void>(MESSAGING_API.read(cid), {});
}

/** Archive / unarchive, delete for me, block / unblock (one change per call). */
export function changeConversationState(cid: string, change: ConversationStateRequest): Promise<void> {
  return apiPost<void>(MESSAGING_API.state(cid), change);
}

export function fetchUnread(): Promise<UnreadResponse> {
  return apiGet<UnreadResponse>(MESSAGING_API.unread);
}
